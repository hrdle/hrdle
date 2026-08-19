/**
 * herdr version reporting and updating.
 *
 * Two things can be stale: the running server behind the on-disk binary
 * (skew — `herdr update` swaps the binary only, and hrdle spawns that binary
 * to drive panes), and the binary behind the published release
 * (`herdr.dev/latest.json`; `herdr status --json` cannot see that one).
 *
 * Applying is strictly a user action — a restart re-creates every pane PTY.
 * Never the `hrdle update --auto` timer, never `--handoff`.
 */

import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { HerdrUpdateStatus } from '../../../shared/types';
import { herdrBin, herdrBinaryPath, herdrChildEnv } from './herdr-client';

/** Matches the dashboard's own refresh cadence; a spawn per poll is plenty. */
const CACHE_TTL_MS = 30_000;
const SPAWN_TIMEOUT_MS = 5_000;

/** herdr's own release manifest — public, unauthenticated, and what `herdr update` reads. */
const LATEST_MANIFEST_URL = 'https://herdr.dev/latest.json';
/** Releases land weekly at most, and a stale answer costs a day of not knowing. */
const MANIFEST_TTL_MS = 6 * 60 * 60 * 1000;
/** After a failure, stop asking for a while: the dashboard polls every few seconds. */
const MANIFEST_BACKOFF_MS = 30 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 5_000;
/** `systemctl start` returns once the process is spawned, not once it answers. */
const SERVER_READY_TIMEOUT_MS = 20_000;

export type HerdrSupervisor = 'systemd' | 'launchd' | 'unmanaged';

export interface HerdrSkewReading {
  binaryVersion?: string;
  serverVersion?: string;
  restartNeeded: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Read `herdr status --json` (binary and server versions side by side, plus
 * herdr's own `restart_needed` verdict). Every field is optional: a format
 * change must degrade to "no skew detected", not a false restart nag. Null
 * when the output is unusable.
 */
export function parseHerdrStatus(raw: string): HerdrSkewReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const root = parsed as Record<string, unknown>;
  const client = (root.client ?? {}) as Record<string, unknown>;
  const server = (root.server ?? {}) as Record<string, unknown>;
  const update = (root.update ?? {}) as Record<string, unknown>;
  if (typeof server !== 'object' || server === null) return null;

  // Only a *running* server can be stale. A stopped one is hrdle's startup
  // problem, not a version skew, and a missing/renamed field lands here too.
  if (server.running !== true) return null;

  const binaryVersion = asString(client.version);
  const serverVersion = asString(server.version);

  // herdr's explicit verdicts win; the version compare is the fallback for
  // builds that don't emit them. Any difference counts as skew — hrdle can't
  // tell a compatible bump from a breaking one, and the fix is identical.
  const restartNeeded =
    update.restart_needed === true ||
    server.restart_needed === true ||
    server.compatible === false ||
    (binaryVersion !== undefined && serverVersion !== undefined && binaryVersion !== serverVersion);

  return { binaryVersion, serverVersion, restartNeeded };
}

export interface HerdrLatestManifest {
  version: string;
  protocol?: number;
}

/**
 * Read `herdr.dev/latest.json`. Only the version is load-bearing; null for
 * anything unusable, so a format change reads as "no information".
 */
export function parseLatestManifest(raw: string): HerdrLatestManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const version = asString(root.version);
  if (!version) return null;
  return {
    version,
    protocol: typeof root.protocol === 'number' ? root.protocol : undefined,
  };
}

/**
 * Order two `MAJOR.MINOR.PATCH` versions; negative when `a` is older.
 * Anything unparseable compares as *equal* — "no update available" is the
 * direction that restarts nothing.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10));
  const left = parts(a);
  const right = parts(b);
  if (left.length === 0 || right.length === 0) return 0;
  if (left.some((n) => Number.isNaN(n)) || right.some((n) => Number.isNaN(n))) return 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** `install` swaps the binary as well; `restart` only bounces the server. */
export type HerdrApplyMode = 'install' | 'restart';

/**
 * What pressing the button should actually do, or null for "nothing" — the
 * important answer, since a restart with nothing to install is pure damage.
 */
export function planHerdrApply(status: HerdrUpdateStatus): HerdrApplyMode | null {
  if (status.updateAvailable) return 'install';
  // The binary is already the one we want; only the running server is behind it.
  if (status.restartNeeded) return 'restart';
  return null;
}

/**
 * Whether a binary resolves into a Homebrew Cellar — `herdr update` refuses
 * those with exit 1; they must go through `brew upgrade herdr`. Takes the
 * *resolved* path: the Cellar segment is behind a symlink.
 */
export function isBrewManagedPath(resolvedBinaryPath: string): boolean {
  return resolvedBinaryPath.includes(`${sep}Cellar${sep}herdr${sep}`);
}

/**
 * Running herdr sessions other than the default one, from
 * `herdr session list --json`. Anything unusable reads as an empty list: a
 * server we cannot see costs a refused update, while guessing at one costs
 * somebody's panes.
 */
export function parseRunningNamedSessions(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const rows = (parsed as Record<string, unknown>).sessions;
  if (!Array.isArray(rows)) return [];
  const names: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    if (entry.running !== true || entry.default === true) continue;
    const name = asString(entry.name);
    if (name) names.push(name);
  }
  return names;
}

/**
 * Stops for the servers the supervisor does not own. `herdr update` replaces
 * nothing while *any* herdr server answers — it lists them, says `Herdr was
 * not updated.` and exits 0 — and the steward keeps a session of its own
 * running for as long as it is enabled, so on a machine with it on the button
 * could never install anything.
 *
 * They are not started again afterwards. The steward's own supervisor brings
 * its session back when the steward is enabled, which is the only place that
 * knows whether it should exist; anything else that was running was somebody's
 * dev server, and hrdle has no business resurrecting one.
 */
export function buildHerdrSessionStopCommands(herdrPath: string, sessions: string[]): string[][] {
  return sessions.map((name) => [herdrPath, 'session', 'stop', name]);
}

export interface HerdrApplyResult {
  ok: boolean;
  error?: string;
  /** Combined stdout/stderr of every command run, so a refusal is readable. */
  output: string;
  fromVersion?: string;
  toVersion?: string;
  /** A new binary was installed, as opposed to the server merely being restarted. */
  installed: boolean;
}

/**
 * Commands hrdle runs on the user's behalf, in order; callers stop at the
 * first non-zero exit. Null when the work cannot be done here (unsupervised).
 *
 * **The server must be down before `herdr update` runs** — it refuses to
 * replace the binary while any server answers its socket, by printing `Herdr
 * was not updated.` and exiting 0.
 *
 * **A brew-managed binary is the opposite case.** `herdr update` refuses it
 * outright, and `brew upgrade` does not care about the socket — so with
 * `brewPath` set the upgrade runs *first*, while the server is still up: panes
 * stay alive through the download and a brew failure touches nothing. No plist
 * needed either; the job is kickstarted, never booted out.
 */
export function buildHerdrApplyCommands(
  supervisor: HerdrSupervisor,
  herdrPath: string,
  uid: number,
  mode: HerdrApplyMode = 'install',
  launchdPlistPath?: string,
  brewPath?: string,
): string[][] | null {
  switch (supervisor) {
    case 'systemd':
      if (mode === 'restart') return [['systemctl', '--user', 'restart', 'herdr']];
      if (brewPath) {
        return [
          [brewPath, 'upgrade', 'herdr'],
          ['systemctl', '--user', 'restart', 'herdr'],
        ];
      }
      return [
        ['systemctl', '--user', 'stop', 'herdr'],
        [herdrPath, 'update'],
        ['systemctl', '--user', 'start', 'herdr'],
      ];
    case 'launchd': {
      const label = `gui/${uid}/com.herdr.server`;
      if (mode === 'restart') return [['launchctl', 'kickstart', '-k', label]];
      if (brewPath) {
        return [
          [brewPath, 'upgrade', 'herdr'],
          ['launchctl', 'kickstart', '-k', label],
        ];
      }
      // Installing needs the job *gone*, not bounced: `bootout` keeps it down,
      // and coming back needs the plist it was loaded from.
      if (!launchdPlistPath) return null;
      return [
        ['launchctl', 'bootout', label],
        [herdrPath, 'update'],
        ['launchctl', 'bootstrap', `gui/${uid}`, launchdPlistPath],
      ];
    }
    default:
      return null;
  }
}

/**
 * Brings the supervised server back after a failed install left it stopped —
 * without this, a failure between stop and start strands the launchd job
 * booted out and the apply button never comes back (`canApply` needs a
 * supervisor). Null when there is nothing usable to run.
 */
export function buildHerdrRestoreCommand(
  supervisor: HerdrSupervisor,
  uid: number,
  launchdPlistPath?: string,
): string[] | null {
  switch (supervisor) {
    case 'systemd':
      return ['systemctl', '--user', 'start', 'herdr'];
    case 'launchd':
      return launchdPlistPath ? ['launchctl', 'bootstrap', `gui/${uid}`, launchdPlistPath] : null;
    default:
      return null;
  }
}

/**
 * The environment the apply commands run in. An inherited `HERDR_SOCKET_PATH`
 * wins over the session a herdr command names, so with one set
 * `herdr session stop <name>` would answer about the socket it was handed
 * instead of the session it was told to stop.
 */
function applyEnv(): Record<string, string> {
  const { HERDR_SOCKET_PATH: _socket, HERDR_SESSION: _session, ...rest } = process.env;
  return rest as Record<string, string>;
}

/** The last thing a command said, which is where herdr puts its reason. */
function lastLine(output: string): string | undefined {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
}

async function runCapture(
  cmd: string[],
  env: Record<string, string> = herdrChildEnv(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Pinned to our socket like every other herdr child: `herdr status` reports
  // the running server's version, and reading the default server's would make
  // the skew warning describe a server we are not talking to.
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env });
  const timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

let applying = false;

/**
 * Whether an install is running right now. Anything that keeps a herdr server
 * alive has to stand down while it is: the update has just stopped every
 * server it found, and one restarted underneath it makes herdr refuse to
 * replace the binary at all.
 */
export function herdrUpdateInProgress(): boolean {
  return applying;
}

export class HerdrUpdateService {
  private cached: HerdrUpdateStatus | undefined;
  private cachedAt = 0;
  private inFlight: Promise<HerdrUpdateStatus | undefined> | null = null;
  private manifest: HerdrLatestManifest | null = null;
  private manifestAt = 0;
  private manifestFailedAt = 0;

  /**
   * Undefined means "nothing to say" — herdr missing or an unreadable status.
   * Callers should render a warning for `restartNeeded` or `updateAvailable`;
   * neither being set is the ordinary, silent case.
   */
  async getStatus(): Promise<HerdrUpdateStatus | undefined> {
    if (Date.now() - this.cachedAt < CACHE_TTL_MS) return this.cached;
    // Several dashboard pollers (local card + peers) can land together; one
    // spawn serves them all.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.probe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Force the next getStatus() to re-probe (used right after applying). */
  invalidate(): void {
    this.cachedAt = 0;
  }

  private async probe(): Promise<HerdrUpdateStatus | undefined> {
    const status = await this.readStatus();
    this.cached = status;
    this.cachedAt = Date.now();
    return status;
  }

  /**
   * The newest published release, cached hard. A failure keeps serving the last
   * good answer rather than retracting the notice the user is looking at.
   */
  private async readLatest(): Promise<HerdrLatestManifest | null> {
    const now = Date.now();
    if (this.manifest && now - this.manifestAt < MANIFEST_TTL_MS) return this.manifest;
    if (now - this.manifestFailedAt < MANIFEST_BACKOFF_MS) return this.manifest;
    try {
      const res = await fetch(LATEST_MANIFEST_URL, {
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseLatestManifest(await res.text());
      if (!parsed) throw new Error('unparseable manifest');
      this.manifest = parsed;
      this.manifestAt = now;
      return parsed;
    } catch {
      this.manifestFailedAt = now;
      return this.manifest;
    }
  }

  private async readStatus(): Promise<HerdrUpdateStatus | undefined> {
    if (!herdrBinaryPath()) return undefined; // herdr not installed

    let reading: HerdrSkewReading | null = null;
    try {
      const { exitCode, stdout } = await runCapture([herdrBin(), 'status', '--json']);
      if (exitCode !== 0) return undefined;
      reading = parseHerdrStatus(stdout);
    } catch {
      return undefined;
    }
    if (!reading) return undefined;

    const latest = await this.readLatest();
    const updateAvailable =
      latest !== null &&
      reading.binaryVersion !== undefined &&
      compareVersions(latest.version, reading.binaryVersion) > 0;

    // Either reason is worth a button, and they need different work: skew alone
    // is a restart, a newer release is a stop/update/start.
    const actionable = reading.restartNeeded || updateAvailable;
    const supervisor = actionable ? await this.detectSupervisor() : 'unmanaged';
    return {
      binaryVersion: reading.binaryVersion,
      serverVersion: reading.serverVersion,
      restartNeeded: reading.restartNeeded,
      latestVersion: latest?.version,
      updateAvailable,
      canApply: actionable && supervisor !== 'unmanaged',
    };
  }

  /** Sessions with a server up that the supervisor does not own. */
  private async readRunningNamedSessions(): Promise<string[]> {
    try {
      const { exitCode, stdout } = await runCapture(
        [herdrBin(), 'session', 'list', '--json'],
        applyEnv(),
      );
      if (exitCode !== 0) return [];
      return parseRunningNamedSessions(stdout);
    } catch {
      return [];
    }
  }

  /**
   * The binary's own version, readable while the server is stopped — which is
   * exactly when we need to know whether the swap landed.
   */
  private async readBinaryVersion(): Promise<string | undefined> {
    try {
      const { exitCode, stdout } = await runCapture([herdrBin(), '--version']);
      if (exitCode !== 0) return undefined;
      return /(\d+\.\d+\.\d+\S*)/.exec(stdout)?.[1];
    } catch {
      return undefined;
    }
  }

  /** Wait for the restarted server to answer its socket, not merely to exist. */
  private async waitForServer(timeoutMs = SERVER_READY_TIMEOUT_MS): Promise<HerdrSkewReading | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const { exitCode, stdout } = await runCapture([herdrBin(), 'status', '--json']);
        const reading = exitCode === 0 ? parseHerdrStatus(stdout) : null;
        if (reading) return reading;
      } catch {
        // fall through to the retry
      }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Where launchd loaded the job from — `bootstrap` needs it, and there is no fixed location worth guessing. */
  private async detectLaunchdPlist(uid: number): Promise<string | undefined> {
    try {
      const { exitCode, stdout } = await runCapture([
        'launchctl',
        'print',
        `gui/${uid}/com.herdr.server`,
      ]);
      if (exitCode !== 0) return undefined;
      return /^\s*path\s*=\s*(\S.*?)\s*$/m.exec(stdout)?.[1];
    } catch {
      return undefined;
    }
  }

  /**
   * The `brew` binary to upgrade herdr with, or undefined when herdr is not
   * brew-managed. Falls back from PATH to `<prefix>/bin/brew` derived from the
   * Cellar, for service environments that never saw the brew shellenv.
   */
  private async detectBrewPath(): Promise<string | undefined> {
    try {
      const binary = herdrBinaryPath();
      if (!binary) return undefined;
      const resolved = await realpath(binary);
      if (!isBrewManagedPath(resolved)) return undefined;
      const onPath = Bun.which('brew');
      if (onPath) return onPath;
      const prefix = resolved.slice(0, resolved.indexOf(`${sep}Cellar${sep}`));
      const candidate = join(prefix, 'bin', 'brew');
      return (await Bun.file(candidate).exists()) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  async detectSupervisor(): Promise<HerdrSupervisor> {
    try {
      if (process.platform === 'darwin') {
        const { exitCode } = await runCapture([
          'launchctl',
          'print',
          `gui/${process.getuid?.() ?? 0}/com.herdr.server`,
        ]);
        return exitCode === 0 ? 'launchd' : 'unmanaged';
      }
      const { stdout } = await runCapture(['systemctl', '--user', 'is-active', 'herdr']);
      return stdout.trim() === 'active' ? 'systemd' : 'unmanaged';
    } catch {
      return 'unmanaged';
    }
  }

  /**
   * Install the published release (or restart a stale server) and confirm the
   * version actually moved. Only called behind an explicit user click.
   * `onPhase` tells connected clients about the destructive window — every
   * pane PTY is re-created between `restarting` and `restored`.
   */
  async apply(onPhase?: (phase: 'restarting' | 'restored' | 'failed') => void): Promise<HerdrApplyResult> {
    applying = true;
    try {
      return await this.runApply(onPhase);
    } finally {
      applying = false;
    }
  }

  private async runApply(
    onPhase?: (phase: 'restarting' | 'restored' | 'failed') => void,
  ): Promise<HerdrApplyResult> {
    const before = await this.readStatus();
    if (!before) {
      return { ok: false, error: 'herdr status is unreadable; not touching the server', output: '', installed: false };
    }

    // Nothing to do is not a reason to restart anything. Say so and leave
    // every pane alone.
    const mode = planHerdrApply(before);
    if (!mode) {
      return {
        ok: true,
        output: `herdr ${before.binaryVersion ?? '?'} is already current; nothing was restarted`,
        fromVersion: before.binaryVersion,
        toVersion: before.binaryVersion,
        installed: false,
      };
    }

    const uid = process.getuid?.() ?? 0;
    const supervisor = await this.detectSupervisor();
    const brewPath = mode === 'install' ? await this.detectBrewPath() : undefined;
    const plist =
      supervisor === 'launchd' && mode === 'install' && !brewPath
        ? await this.detectLaunchdPlist(uid)
        : undefined;
    const supervised = buildHerdrApplyCommands(supervisor, herdrBin(), uid, mode, plist, brewPath);
    if (!supervised) {
      return {
        ok: false,
        error:
          supervisor === 'launchd'
            ? "could not find herdr's launchd plist; run `herdr update` with the server stopped"
            : 'herdr is not managed by systemd/launchd; restart it manually',
        output: '',
        installed: false,
      };
    }

    // Stopping the sessions hrdle does not supervise comes first, so the last
    // thing standing before `herdr update` is still the supervised stop.
    // Skipped for brew, which replaces the binary with every server up.
    const prelude =
      mode === 'install' && !brewPath
        ? buildHerdrSessionStopCommands(herdrBin(), await this.readRunningNamedSessions())
        : [];
    const commands = [...prelude, ...supervised];

    onPhase?.('restarting');
    let output = '';
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: applyEnv() });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      output += stdout + stderr;
      if (exitCode !== 0) {
        // The self-update sequence stops the server first; a mid-sequence
        // failure must not leave it down and unsupervised.
        let restoreNote = '';
        if (!brewPath && mode === 'install' && i > prelude.length && i < commands.length - 1) {
          const restore = buildHerdrRestoreCommand(supervisor, uid, plist);
          if (restore) {
            const restored = await Bun.spawn(restore, { stdout: 'pipe', stderr: 'pipe', env: applyEnv() });
            const [rout, rerr, rcode] = await Promise.all([
              new Response(restored.stdout).text(),
              new Response(restored.stderr).text(),
              restored.exited,
            ]);
            output += rout + rerr;
            restoreNote =
              rcode === 0 ? '; the server was restarted on the old version' : '; restarting the server also failed';
          }
        }
        // The exit code alone says nothing; the refusal reason is in the output.
        const detail = lastLine(stdout + stderr);
        onPhase?.('failed');
        return {
          ok: false,
          error: `${cmd.join(' ')} failed (exit ${exitCode})${detail ? `: ${detail}` : ''}${restoreNote}`,
          output,
          fromVersion: before.binaryVersion,
          installed: false,
        };
      }
    }

    this.invalidate();
    const toVersion = await this.readBinaryVersion();

    // Exit codes are not evidence (`herdr update` can refuse and exit 0); the
    // only proof of an install is the version on disk having moved.
    if (
      mode === 'install' &&
      !(before.binaryVersion && toVersion && compareVersions(toVersion, before.binaryVersion) > 0)
    ) {
      onPhase?.('failed');
      // `herdr update` says why in its output and then exits 0, so without
      // this the one line that explains the failure is the one nobody sees.
      const reason = lastLine(output);
      return {
        ok: false,
        error: `herdr update installed nothing; still ${toVersion ?? 'an unknown version'}${reason ? `: ${reason}` : ''}`,
        output,
        fromVersion: before.binaryVersion,
        toVersion,
        installed: false,
      };
    }

    // Clients are told the panes are usable only once the server answers again,
    // not merely once systemd has spawned it.
    await this.waitForServer();
    onPhase?.('restored');
    return {
      ok: true,
      output,
      fromVersion: before.binaryVersion,
      toVersion,
      installed: mode === 'install',
    };
  }
}
