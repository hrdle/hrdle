/**
 * herdr version-skew detection (#393).
 *
 * `herdr update` only replaces the binary on disk — the running server keeps
 * serving the old version until it is restarted. cchub spawns the *binary*
 * (`herdr terminal session control`, see PaneController) to drive panes, so
 * between `herdr update` and a server restart we run new CLI against an old
 * server: control streams can fail to attach and the symptom reads as
 * "the terminal won't connect", long after the user forgot they ran an update.
 *
 * We only *report* the skew. Restarting herdr re-creates every pane PTY and
 * kills whatever is running in them, so applying is strictly a user action
 * (never the `cchub update --auto` timer, never `--handoff`: a handed-off
 * server escapes systemd/launchd supervision and fights `Restart=always`).
 */

import type { HerdrUpdateStatus } from '../../../shared/types';
import { herdrBin, herdrBinaryPath, herdrChildEnv } from './herdr-client';

/** Matches the dashboard's own refresh cadence; a spawn per poll is plenty. */
const CACHE_TTL_MS = 30_000;
const SPAWN_TIMEOUT_MS = 5_000;

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

/**
 * Commands cchub runs on the user's behalf, in order. `herdr update` must
 * succeed before the restart, so callers stop at the first non-zero exit.
 * Returns null when nothing supervises herdr: `systemctl restart` is a no-op
 * for a server cchub itself spawned, so we show manual steps instead of a
 * button that silently does nothing.
 */
export function buildHerdrApplyCommands(
  supervisor: HerdrSupervisor,
  herdrPath: string,
  uid: number,
): string[][] | null {
  switch (supervisor) {
    case 'systemd':
      return [
        [herdrPath, 'update'],
        ['systemctl', '--user', 'restart', 'herdr'],
      ];
    case 'launchd':
      return [
        [herdrPath, 'update'],
        ['launchctl', 'kickstart', '-k', `gui/${uid}/com.herdr.server`],
      ];
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

  /**
   * Undefined means "nothing to say" — herdr missing, unreadable status, or no
   * skew worth surfacing. Callers should render a warning only for
   * `restartNeeded`.
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

    const supervisor = reading.restartNeeded ? await this.detectSupervisor() : 'unmanaged';
    return {
      binaryVersion: reading.binaryVersion,
      serverVersion: reading.serverVersion,
      restartNeeded: reading.restartNeeded,
      canApply: reading.restartNeeded && supervisor !== 'unmanaged',
    };
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
   * Run `herdr update` and restart the supervised server. Only ever called
   * from the authenticated endpoint behind an explicit user click.
   */
  async apply(): Promise<{ ok: boolean; error?: string; output: string }> {
    const supervisor = await this.detectSupervisor();
    const commands = buildHerdrApplyCommands(supervisor, herdrBin(), process.getuid?.() ?? 0);
    if (!commands) {
      return {
        ok: false,
        error: 'herdr is not managed by systemd/launchd; restart it manually',
        output: '',
      };
    }

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
        return { ok: false, error: `${cmd.join(' ')} failed (exit ${exitCode})`, output };
      }
    }

    this.invalidate();
    return { ok: true, output };
  }
}
