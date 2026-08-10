/**
 * herdr version reporting and updating (#393, #259, #260).
 *
 * Two different things can be out of date, and only one of them used to be
 * visible here:
 *
 * 1. **Skew** — `herdr update` only replaces the binary on disk; the running
 *    server keeps serving the old version until it is restarted. cchub spawns
 *    the *binary* (`herdr terminal session control`, see PaneController) to
 *    drive panes, so in between we run new CLI against an old server: control
 *    streams fail to attach and the symptom reads as "the terminal won't
 *    connect", long after the user forgot they ran an update.
 * 2. **A newer release existing at all** — with the binary and the server on
 *    the same old version there is no skew to see, and `herdr status --json`
 *    answers only the skew question. So for months the dashboard was silent
 *    while herdr moved on (#259). The version herdr publishes at
 *    `herdr.dev/latest.json` is the missing half.
 *
 * Applying is strictly a user action. Restarting herdr re-creates every pane
 * PTY and kills whatever is running in them (never the `cchub update --auto`
 * timer, never `--handoff`: a handed-off server escapes systemd/launchd
 * supervision and fights `Restart=always`).
 */

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
 * Read `herdr status --json`, which reports the on-disk binary (`client`) and
 * the live server side by side plus herdr's own `restart_needed` verdict.
 *
 * Every field is treated as optional and unknown values are ignored: herdr's
 * output format is versioned independently of cchub, and a format change must
 * degrade to "no skew detected" rather than nag the user with a false alarm.
 * Returns null when the output is unusable.
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

  // Only a *running* server can be stale. A stopped one is cchub's startup
  // problem, not a version skew, and a missing/renamed field lands here too.
  if (server.running !== true) return null;

  const binaryVersion = asString(client.version);
  const serverVersion = asString(server.version);

  // herdr's explicit verdicts win; the version compare is the fallback for
  // builds that don't emit them. Any difference counts as skew — cchub can't
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
 * Read `herdr.dev/latest.json`. Only the version is load-bearing; the manifest
 * also carries assets, checksums and the changelog, which are `herdr update`'s
 * business rather than ours. Returns null for anything unusable, so a format
 * change reads as "no information" instead of a wrong version.
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
 *
 * Anything that doesn't parse compares as *equal*, which is the safe direction:
 * an unknown version string produces "no update available" rather than an
 * update prompt that would restart every pane on the strength of a string we
 * failed to read.
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
 * What pressing the button should actually do, or null for "nothing".
 *
 * Null is the important answer: a restart re-creates every pane PTY and kills
 * whatever was running in them, so doing it when there is nothing to install is
 * pure damage. That is what the old apply did on every press (#260).
 */
export function planHerdrApply(status: HerdrUpdateStatus): HerdrApplyMode | null {
  if (status.updateAvailable) return 'install';
  // The binary is already the one we want; only the running server is behind it.
  if (status.restartNeeded) return 'restart';
  return null;
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
 * Commands cchub runs on the user's behalf, in order; callers stop at the first
 * non-zero exit. Returns null when the work cannot be done here: `systemctl
 * restart` is a no-op for a server cchub itself spawned, so we show manual
 * steps instead of a button that silently does nothing.
 *
 * **The server must be down before `herdr update` runs** (#260). It refuses to
 * replace the binary while any server answers its socket — and refuses by
 * printing `Herdr was not updated.` and **exiting 0**. The previous order here
 * (update, then restart) therefore could never install anything: it downloaded
 * the release, discarded it, and restarted every pane PTY for nothing while
 * reporting success.
 */
export function buildHerdrApplyCommands(
  supervisor: HerdrSupervisor,
  herdrPath: string,
  uid: number,
  mode: HerdrApplyMode = 'install',
  launchdPlistPath?: string,
): string[][] | null {
  switch (supervisor) {
    case 'systemd':
      if (mode === 'restart') return [['systemctl', '--user', 'restart', 'herdr']];
      return [
        ['systemctl', '--user', 'stop', 'herdr'],
        [herdrPath, 'update'],
        ['systemctl', '--user', 'start', 'herdr'],
      ];
    case 'launchd': {
      const label = `gui/${uid}/com.herdr.server`;
      if (mode === 'restart') return [['launchctl', 'kickstart', '-k', label]];
      // Installing needs the job *gone*, not bounced — `kickstart -k` hands the
      // socket straight back to a new server, which `herdr update` then refuses
      // to update around. `bootout` is the verb that keeps it down, and coming
      // back needs the plist it was loaded from.
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

async function runCapture(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Pinned to our socket like every other herdr child: `herdr status` reports
  // the running server's version, and reading the default server's would make
  // the skew warning describe a server we are not talking to.
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: herdrChildEnv() });
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

  /**
   * The binary's own version, read without a server — `herdr status --json`
   * reports nothing while herdr is stopped, which is exactly when we need to
   * know whether the swap landed.
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

  /**
   * Where launchd loaded the job from. `bootstrap` needs it, and there is no
   * fixed location worth guessing — herdr may have been installed by brew or by
   * hand.
   */
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
   * Install the published release (or, when only the server is stale, restart
   * it) and confirm the version actually moved. Only ever called from the
   * authenticated endpoint behind an explicit user click.
   *
   * `onPhase` reports the destructive window to connected clients (#261): every
   * pane PTY is re-created between `restarting` and `restored`, and a browser
   * that isn't told just shows a terminal that has stopped answering.
   */
  async apply(onPhase?: (phase: 'restarting' | 'restored' | 'failed') => void): Promise<HerdrApplyResult> {
    const before = await this.readStatus();
    if (!before) {
      return { ok: false, error: 'herdr status is unreadable; not touching the server', output: '', installed: false };
    }

    // Nothing to do is not a reason to restart anything — that was the whole
    // cost of #260. Say so and leave every pane alone.
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
    const plist =
      supervisor === 'launchd' && mode === 'install' ? await this.detectLaunchdPlist(uid) : undefined;
    const commands = buildHerdrApplyCommands(supervisor, herdrBin(), uid, mode, plist);
    if (!commands) {
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

    onPhase?.('restarting');
    let output = '';
    for (const cmd of commands) {
      const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      output += stdout + stderr;
      if (exitCode !== 0) {
        onPhase?.('failed');
        return {
          ok: false,
          error: `${cmd.join(' ')} failed (exit ${exitCode})`,
          output,
          fromVersion: before.binaryVersion,
          installed: false,
        };
      }
    }

    this.invalidate();
    const toVersion = await this.readBinaryVersion();

    // Exit codes are not evidence. `herdr update` prints "Herdr was not
    // updated." and exits 0 whenever a server was still answering, so the only
    // proof an install happened is the version on disk having moved (#260).
    if (
      mode === 'install' &&
      !(before.binaryVersion && toVersion && compareVersions(toVersion, before.binaryVersion) > 0)
    ) {
      onPhase?.('failed');
      return {
        ok: false,
        error: `herdr update installed nothing; still ${toVersion ?? 'an unknown version'}`,
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
