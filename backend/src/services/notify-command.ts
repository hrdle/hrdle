import { basename } from 'node:path';
import { HOOK_COMMAND, IDENTITY } from '../../../shared/identity';

/**
 * The `cchub notify` invocation to write into an agent's hook config.
 *
 * A bare `cchub notify` only resolves if the hook's shell can find cchub, and
 * hooks run in a *non-interactive* shell: `.zshrc` is never sourced, so the
 * `~/bin` / `~/.local/bin` that most installs land in are absent from PATH
 * (#538). The supervised units sidestep this with a baked `Environment=PATH=`,
 * but hooks are spawned by the agent, outside the unit — the notification just
 * silently stops arriving.
 *
 * An absolute path has no PATH to be wrong about, and it also settles which
 * binary answers when both `~/bin/cchub` and `~/.local/bin/cchub` exist.
 */
export function notifyCommandFor(execPath: string): string {
  // Running from source (`bun run src/index.ts`) makes execPath the *bun*
  // binary, and `<bun> notify` is not a command anyone wants baked into their
  // hooks. A bare name is the honest fallback there: dev is also where PATH is
  // most likely to be fine, since it was started from an interactive shell.
  if (!basename(execPath).startsWith(IDENTITY.binaryName)) return HOOK_COMMAND;
  // Hook commands go through a shell, so a path with spaces needs quoting.
  return /\s/.test(execPath) ? `"${execPath}" notify` : `${execPath} notify`;
}

/** `notifyCommandFor` against the running binary. */
export function resolveNotifyCommand(): string {
  return notifyCommandFor(process.execPath);
}
