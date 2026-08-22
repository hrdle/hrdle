import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildHerdrApplyCommands,
  buildHerdrRestoreCommand,
  buildHerdrSessionStopCommands,
  brewBinaryForCellarPath,
  compareVersions,
  isBrewManagedPath,
  isStrayDefaultServer,
  parseHerdrStatus,
  parseLatestManifest,
  parseRunningNamedSessions,
  parseSystemdLoadState,
  planHerdrApply,
  withStrayServerStop,
} from '../herdr-update';

/**
 * The parser must catch binary-vs-server skew, but an unreadable status format
 * must degrade to silence — a false restart nag costs every running command.
 */
describe('parseHerdrStatus', () => {
  // Real `herdr status --json` output (herdr 0.7.3, protocol 16).
  const healthy = JSON.stringify({
    client: { version: '0.7.3', channel: 'stable', protocol: 16, binary: '/home/u/.local/bin/herdr', session: null },
    server: {
      status: 'running',
      running: true,
      version: '0.7.3',
      protocol: 16,
      capabilities: { live_handoff: true, detached_server_daemon: true },
      compatible: true,
      socket: '/home/u/.config/herdr/herdr.sock',
      session: null,
      restart_needed: false,
    },
    update: { restart_needed: false },
  });

  it('reports no skew when binary and server match', () => {
    expect(parseHerdrStatus(healthy)).toEqual({
      binaryVersion: '0.7.3',
      serverVersion: '0.7.3',
      restartNeeded: false,
    });
  });

  it('detects skew from differing versions', () => {
    const raw = JSON.stringify({
      client: { version: '0.7.4' },
      server: { running: true, version: '0.7.3' },
    });
    expect(parseHerdrStatus(raw)?.restartNeeded).toBe(true);
  });

  it('honors herdr update.restart_needed even when versions read equal', () => {
    const raw = JSON.stringify({
      client: { version: '0.7.3' },
      server: { running: true, version: '0.7.3' },
      update: { restart_needed: true },
    });
    expect(parseHerdrStatus(raw)?.restartNeeded).toBe(true);
  });

  it('treats an incompatible server as needing a restart', () => {
    const raw = JSON.stringify({
      client: { version: '0.8.0' },
      server: { running: true, version: '0.8.0', compatible: false },
    });
    expect(parseHerdrStatus(raw)?.restartNeeded).toBe(true);
  });

  it('exposes both versions so the UI can name them', () => {
    const raw = JSON.stringify({
      client: { version: '0.7.4' },
      server: { running: true, version: '0.7.3' },
    });
    const reading = parseHerdrStatus(raw);
    expect(reading?.binaryVersion).toBe('0.7.4');
    expect(reading?.serverVersion).toBe('0.7.3');
  });

  it('ignores unknown fields a newer herdr may add', () => {
    const raw = JSON.stringify({
      client: { version: '0.7.3', someNewField: 'x' },
      server: { running: true, version: '0.7.3', futureFlag: 42 },
      update: { restart_needed: false },
      brandNewSection: { anything: true },
    });
    expect(parseHerdrStatus(raw)?.restartNeeded).toBe(false);
  });

  // Everything below must not warn: unreadable input means "don't know".
  it.each([
    ['empty output', ''],
    ['non-JSON text output', 'status: running\nversion: 0.7.3\ncompatible: yes'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '"running"'],
    ['truncated JSON', '{"client":{"version":"0.7.3"'],
    ['a usage error from an older herdr', 'error: unknown flag --json'],
  ])('returns null for %s', (_label, raw) => {
    expect(parseHerdrStatus(raw)).toBeNull();
  });

  it('stays silent when the server is not running', () => {
    const raw = JSON.stringify({
      client: { version: '0.7.4' },
      server: { status: 'stopped', running: false },
    });
    expect(parseHerdrStatus(raw)).toBeNull();
  });

  it('stays silent when the running flag is missing or renamed', () => {
    const raw = JSON.stringify({
      client: { version: '0.7.4' },
      server: { state: 'up', version: '0.7.3' },
    });
    expect(parseHerdrStatus(raw)).toBeNull();
  });

  it('does not infer skew from a missing or blank version', () => {
    for (const server of [{ running: true }, { running: true, version: '' }, { running: true, version: null }]) {
      const raw = JSON.stringify({ client: { version: '0.7.4' }, server });
      expect(parseHerdrStatus(raw)?.restartNeeded).toBe(false);
    }
    const noClient = JSON.stringify({ client: {}, server: { running: true, version: '0.7.3' } });
    expect(parseHerdrStatus(noClient)?.restartNeeded).toBe(false);
  });

  it('does not treat non-boolean restart_needed as a signal', () => {
    const raw = JSON.stringify({
      client: { version: '0.7.3' },
      server: { running: true, version: '0.7.3' },
      update: { restart_needed: 'maybe' },
    });
    expect(parseHerdrStatus(raw)?.restartNeeded).toBe(false);
  });
});

/**
 * `--handoff` is banned (it escapes supervision), and unsupervised herdr gets
 * no button at all.
 */
describe('buildHerdrApplyCommands', () => {
  it('stops the systemd unit before updating, then starts it again', () => {
    expect(buildHerdrApplyCommands('systemd', '/home/u/.local/bin/herdr', 1000, 'install')).toEqual([
      ['systemctl', '--user', 'stop', 'herdr'],
      ['/home/u/.local/bin/herdr', 'update'],
      ['systemctl', '--user', 'start', 'herdr'],
    ]);
  });

  /** `herdr update` refuses (exit 0) while a server answers its socket, so the stop must come first. */
  it('never runs the update while the server is still up', () => {
    for (const supervisor of ['systemd', 'launchd'] as const) {
      const commands =
        buildHerdrApplyCommands(supervisor, 'herdr', 1000, 'install', '/tmp/com.herdr.server.plist') ??
        [];
      const updateAt = commands.findIndex((cmd) => cmd.includes('update'));
      expect(updateAt).toBeGreaterThan(0);
      const stop = commands[updateAt - 1].join(' ');
      expect(stop === 'systemctl --user stop herdr' || stop.startsWith('launchctl bootout')).toBe(true);
    }
  });

  it('boots the launchd job out and back in around the update', () => {
    expect(
      buildHerdrApplyCommands(
        'launchd',
        '/opt/homebrew/bin/herdr',
        501,
        'install',
        '/Users/u/Library/LaunchAgents/com.herdr.server.plist',
      ),
    ).toEqual([
      ['launchctl', 'bootout', 'gui/501/com.herdr.server'],
      ['/opt/homebrew/bin/herdr', 'update'],
      ['launchctl', 'bootstrap', 'gui/501', '/Users/u/Library/LaunchAgents/com.herdr.server.plist'],
    ]);
  });

  /** `bootstrap` cannot bring the job back without it, so offering the button would strand herdr. */
  it('refuses a launchd install when the plist is unknown', () => {
    expect(buildHerdrApplyCommands('launchd', 'herdr', 501, 'install')).toBeNull();
  });

  /** Skew alone means the binary is already right; only the server is stale. */
  it('only bounces the server in restart mode, without touching the binary', () => {
    expect(buildHerdrApplyCommands('systemd', 'herdr', 1000, 'restart')).toEqual([
      ['systemctl', '--user', 'restart', 'herdr'],
    ]);
    expect(buildHerdrApplyCommands('launchd', 'herdr', 501, 'restart')).toEqual([
      ['launchctl', 'kickstart', '-k', 'gui/501/com.herdr.server'],
    ]);
    for (const supervisor of ['systemd', 'launchd'] as const) {
      const flat = (buildHerdrApplyCommands(supervisor, 'herdr', 1000, 'restart') ?? []).flat();
      expect(flat).not.toContain('update');
    }
  });

  it('refuses to act when nothing supervises herdr', () => {
    expect(buildHerdrApplyCommands('unmanaged', '/usr/bin/herdr', 1000)).toBeNull();
  });

  it('never passes --handoff', () => {
    for (const supervisor of ['systemd', 'launchd'] as const) {
      for (const mode of ['install', 'restart'] as const) {
        const flat = (
          buildHerdrApplyCommands(supervisor, 'herdr', 1000, mode, '/tmp/p.plist') ?? []
        ).flat();
        expect(flat).not.toContain('--handoff');
      }
    }
  });

  /**
   * `herdr update` refuses brew-managed binaries outright (exit 1), so the
   * install goes through `brew upgrade` — before anything stops, since brew
   * does not care about the socket and a brew failure must touch nothing.
   */
  it('upgrades a brew-managed install via brew, before the bounce', () => {
    expect(
      buildHerdrApplyCommands('launchd', '/opt/homebrew/bin/herdr', 501, 'install', undefined, '/opt/homebrew/bin/brew'),
    ).toEqual([
      ['/opt/homebrew/bin/brew', 'upgrade', 'herdr'],
      ['launchctl', 'kickstart', '-k', 'gui/501/com.herdr.server'],
    ]);
    expect(
      buildHerdrApplyCommands('systemd', '/home/linuxbrew/.linuxbrew/bin/herdr', 1000, 'install', undefined, '/home/linuxbrew/.linuxbrew/bin/brew'),
    ).toEqual([
      ['/home/linuxbrew/.linuxbrew/bin/brew', 'upgrade', 'herdr'],
      ['systemctl', '--user', 'restart', 'herdr'],
    ]);
  });

  /** The brew path never runs `herdr update`, so it never boots the job out and needs no plist. */
  it('needs no launchd plist for a brew install', () => {
    const commands =
      buildHerdrApplyCommands('launchd', 'herdr', 501, 'install', undefined, '/opt/homebrew/bin/brew') ?? [];
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.flat()).not.toContain('bootout');
    expect(commands.flat()).not.toContain('update');
  });
});

/**
 * The servers the supervisor does not own. `herdr update` lists every running
 * one and refuses to replace the binary while any of them answers, so missing
 * these is an update that downloads and installs nothing.
 */
describe('parseRunningNamedSessions', () => {
  // Real `herdr session list --json` output (herdr 0.8.0).
  const listing = JSON.stringify({
    sessions: [
      {
        default: true,
        name: 'default',
        running: true,
        session_dir: '/home/u/.config/herdr',
        socket_path: '/home/u/.config/herdr/herdr.sock',
      },
      {
        default: false,
        name: 'steward',
        running: true,
        session_dir: '/home/u/.config/herdr/sessions/steward',
        socket_path: '/home/u/.config/herdr/sessions/steward/herdr.sock',
      },
      {
        default: false,
        name: 'promo',
        running: false,
        session_dir: '/home/u/.config/herdr/sessions/promo',
        socket_path: '/home/u/.config/herdr/sessions/promo/herdr.sock',
      },
    ],
  });

  it('takes the running named sessions and leaves the supervised one alone', () => {
    expect(parseRunningNamedSessions(listing)).toEqual(['steward']);
  });

  /** Guessing at a server costs somebody's panes; not seeing one costs a refused update. */
  it('reads anything unusable as no sessions', () => {
    expect(parseRunningNamedSessions('not json')).toEqual([]);
    expect(parseRunningNamedSessions('{}')).toEqual([]);
    expect(parseRunningNamedSessions(JSON.stringify({ sessions: [{ running: true }] }))).toEqual([]);
  });
});

describe('buildHerdrSessionStopCommands', () => {
  it('stops each named session by name', () => {
    expect(buildHerdrSessionStopCommands('/home/u/.local/bin/herdr', ['steward', 'dev'])).toEqual([
      ['/home/u/.local/bin/herdr', 'session', 'stop', 'steward'],
      ['/home/u/.local/bin/herdr', 'session', 'stop', 'dev'],
    ]);
  });

  /** They are the steward's to bring back, and only while the steward is enabled. */
  it('never starts one again', () => {
    expect(buildHerdrSessionStopCommands('herdr', ['steward']).flat()).not.toContain('server');
  });

  it('runs nothing when every other session is down', () => {
    expect(buildHerdrSessionStopCommands('herdr', [])).toEqual([]);
  });

  /**
   * apply() runs these ahead of the supervised commands, which keeps the
   * supervised stop the last thing standing before the update - the window
   * where the user's own server is down stays as short as it was.
   */
  it('leaves the supervised stop immediately before the update', () => {
    const commands = [
      ...buildHerdrSessionStopCommands('herdr', ['steward']),
      ...(buildHerdrApplyCommands('systemd', 'herdr', 1000, 'install') ?? []),
    ];
    const updateAt = commands.findIndex((cmd) => cmd.includes('update'));
    expect(commands[updateAt - 1].join(' ')).toBe('systemctl --user stop herdr');
    expect(commands[0]).toEqual(['herdr', 'session', 'stop', 'steward']);
  });
});

/**
 * Reading a crash-looping unit as "no supervisor" disabled the button on the
 * one machine that needed it, and told the user herdr was unmanaged while
 * systemd restarted it every two seconds.
 */
describe('parseSystemdLoadState', () => {
  it('takes a loaded unit as the supervisor whatever state it is in', () => {
    expect(parseSystemdLoadState('loaded\n')).toBe('systemd');
  });

  it('has no supervisor when the unit does not exist or is masked', () => {
    expect(parseSystemdLoadState('not-found')).toBe('unmanaged');
    expect(parseSystemdLoadState('masked')).toBe('unmanaged');
    expect(parseSystemdLoadState('')).toBe('unmanaged');
  });
});

describe('isStrayDefaultServer', () => {
  /** A unit that is not active cannot be the parent of a server that answers. */
  it('is stray when a server answers and the unit is not active', () => {
    expect(isStrayDefaultServer('activating', true)).toBe(true);
    expect(isStrayDefaultServer('failed', true)).toBe(true);
    expect(isStrayDefaultServer('inactive', true)).toBe(true);
  });

  it('is not stray when the unit is running it', () => {
    expect(isStrayDefaultServer('active', true)).toBe(false);
  });

  /** Nothing to stop, and stopping what is not there fails the whole apply. */
  it('is not stray when no server answers at all', () => {
    expect(isStrayDefaultServer('failed', false)).toBe(false);
  });
});

describe('withStrayServerStop', () => {
  /** After the supervisor's stop: any earlier and the supervisor is free to
   *  start a replacement in the seconds that follow. */
  it('stops the stray server immediately before the update', () => {
    const commands = withStrayServerStop(
      buildHerdrApplyCommands('systemd', '/u/herdr', 1000, 'install') ?? [],
      '/u/herdr',
    );
    expect(commands).toEqual([
      ['systemctl', '--user', 'stop', 'herdr'],
      ['/u/herdr', 'server', 'stop'],
      ['/u/herdr', 'update'],
      ['systemctl', '--user', 'start', 'herdr'],
    ]);
  });

  it('leaves a sequence with no update in it alone', () => {
    const brew = buildHerdrApplyCommands('systemd', '/u/herdr', 1000, 'install', undefined, '/u/brew') ?? [];
    expect(withStrayServerStop(brew, '/u/herdr')).toEqual(brew);
  });

  it('never starts the stray server again - the supervisor is what should hold that socket', () => {
    const commands = withStrayServerStop(
      buildHerdrApplyCommands('systemd', '/u/herdr', 1000, 'install') ?? [],
      '/u/herdr',
    );
    expect(commands.filter((cmd) => cmd[0] === '/u/herdr' && cmd[1] === 'server')).toEqual([
      ['/u/herdr', 'server', 'stop'],
    ]);
  });
});

/**
 * What apply() runs when a failure mid-sequence left the server stopped, so
 * the supervisor is not stranded booted-out.
 */
describe('buildHerdrRestoreCommand', () => {
  it('restarts the systemd unit', () => {
    expect(buildHerdrRestoreCommand('systemd', 1000)).toEqual(['systemctl', '--user', 'start', 'herdr']);
  });

  it('bootstraps the launchd job from its plist', () => {
    expect(buildHerdrRestoreCommand('launchd', 501, '/Users/u/Library/LaunchAgents/com.herdr.server.plist')).toEqual([
      'launchctl',
      'bootstrap',
      'gui/501',
      '/Users/u/Library/LaunchAgents/com.herdr.server.plist',
    ]);
  });

  it('has nothing to run without a plist or supervisor', () => {
    expect(buildHerdrRestoreCommand('launchd', 501)).toBeNull();
    expect(buildHerdrRestoreCommand('unmanaged', 501)).toBeNull();
  });
});

describe('isBrewManagedPath', () => {
  it('recognizes a binary resolved into a Homebrew Cellar', () => {
    expect(isBrewManagedPath('/opt/homebrew/Cellar/herdr/0.7.4/bin/herdr')).toBe(true);
    expect(isBrewManagedPath('/usr/local/Cellar/herdr/0.8.0/bin/herdr')).toBe(true);
    expect(isBrewManagedPath('/home/linuxbrew/.linuxbrew/Cellar/herdr/0.8.0/bin/herdr')).toBe(true);
  });

  it('leaves ordinary installs alone', () => {
    expect(isBrewManagedPath('/home/u/.local/bin/herdr')).toBe(false);
    expect(isBrewManagedPath('/usr/local/bin/herdr')).toBe(false);
    // Another formula's Cellar is not herdr's.
    expect(isBrewManagedPath('/opt/homebrew/Cellar/other/1.0/bin/herdr')).toBe(false);
  });
});

/**
 * An Apple Silicon machine with a leftover Intel Homebrew has two `brew`s, and
 * the service PATH lists `/usr/local/bin` first — so the one on PATH upgraded
 * nothing and said `Error: herdr not installed`. Only the prefix the Cellar
 * sits in owns the formula.
 */
describe('brewBinaryForCellarPath', () => {
  it('derives brew from the prefix the Cellar sits in', () => {
    expect(brewBinaryForCellarPath('/opt/homebrew/Cellar/herdr/0.8.2/bin/herdr')).toBe(
      '/opt/homebrew/bin/brew',
    );
    expect(brewBinaryForCellarPath('/usr/local/Cellar/herdr/0.8.2/bin/herdr')).toBe('/usr/local/bin/brew');
    expect(brewBinaryForCellarPath('/home/linuxbrew/.linuxbrew/Cellar/herdr/0.8.2/bin/herdr')).toBe(
      '/home/linuxbrew/.linuxbrew/bin/brew',
    );
  });

  it('has nothing to derive from outside a Cellar', () => {
    expect(brewBinaryForCellarPath('/usr/local/bin/herdr')).toBeNull();
  });
});

/**
 * The manifest is the only thing that can say an update exists; a format we
 * cannot read must produce silence, not a misparsed version prompt.
 */
describe('parseLatestManifest', () => {
  it('reads the version and protocol herdr publishes', () => {
    const raw = JSON.stringify({
      version: '0.8.0',
      protocol: 19,
      notes: '### Added\n- things',
      assets: { 'linux-x86_64': 'https://example.invalid/herdr' },
      sha256: { 'linux-x86_64': 'abc' },
    });
    expect(parseLatestManifest(raw)).toEqual({ version: '0.8.0', protocol: 19 });
  });

  it('accepts a manifest with no protocol field', () => {
    expect(parseLatestManifest('{"version":"0.8.0"}')).toEqual({
      version: '0.8.0',
      protocol: undefined,
    });
  });

  it('returns null for unusable input', () => {
    expect(parseLatestManifest('not json')).toBeNull();
    expect(parseLatestManifest('[]')).toBeNull();
    expect(parseLatestManifest('{}')).toBeNull();
    expect(parseLatestManifest('{"version":""}')).toBeNull();
    expect(parseLatestManifest('{"version":123}')).toBeNull();
  });
});

/** A press with nothing to install must restart nothing. */
describe('planHerdrApply', () => {
  it('does nothing when the binary is current and the server matches it', () => {
    expect(
      planHerdrApply({
        binaryVersion: '0.8.0',
        serverVersion: '0.8.0',
        latestVersion: '0.8.0',
        updateAvailable: false,
        restartNeeded: false,
        canApply: false,
      }),
    ).toBeNull();
  });

  it('installs when a newer release exists', () => {
    expect(
      planHerdrApply({
        binaryVersion: '0.7.5',
        serverVersion: '0.7.5',
        latestVersion: '0.8.0',
        updateAvailable: true,
        restartNeeded: false,
        canApply: true,
      }),
    ).toBe('install');
  });

  /** The binary is already right here; downloading it again would install nothing. */
  it('only restarts when the server is behind a binary that is already current', () => {
    expect(
      planHerdrApply({
        binaryVersion: '0.8.0',
        serverVersion: '0.7.5',
        latestVersion: '0.8.0',
        updateAvailable: false,
        restartNeeded: true,
        canApply: true,
      }),
    ).toBe('restart');
  });

  /** An unreachable manifest leaves `updateAvailable` undefined, not false. */
  it('still restarts on skew when the latest version is unknown', () => {
    expect(
      planHerdrApply({ binaryVersion: '0.8.0', serverVersion: '0.7.5', restartNeeded: true, canApply: true }),
    ).toBe('restart');
    expect(planHerdrApply({ binaryVersion: '0.8.0', restartNeeded: false, canApply: false })).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders releases', () => {
    expect(compareVersions('0.8.0', '0.7.5')).toBeGreaterThan(0);
    expect(compareVersions('0.7.5', '0.8.0')).toBeLessThan(0);
    expect(compareVersions('0.8.0', '0.8.0')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('ignores a leading v and a missing patch component', () => {
    expect(compareVersions('v0.8.0', '0.8.0')).toBe(0);
    expect(compareVersions('0.8', '0.8.0')).toBe(0);
    expect(compareVersions('0.8.1', '0.8')).toBeGreaterThan(0);
  });

  /** Equal means "no update", which is the direction that costs nothing. */
  it('treats anything unparseable as equal', () => {
    expect(compareVersions('nightly', '0.8.0')).toBe(0);
    expect(compareVersions('0.8.0', '')).toBe(0);
  });
});

/** The unattended timer must never restart herdr; guarded on the source itself. */
describe('hrdle update timer', () => {
  it('never touches herdr', () => {
    const source = readFileSync(join(import.meta.dir, '../../commands/update.ts'), 'utf-8');
    expect(source).not.toMatch(/herdr/i);
  });
});
