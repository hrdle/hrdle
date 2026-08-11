import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { herdrBin, herdrBinaryPath } from '../herdr-client';

/**
 * Regression: hrdle v0.2.0 failed to start under systemd because it resolved
 * herdr through PATH only. `zsh -lc` (the unit's ExecStart) never sources
 * .zshrc, so ~/.local/bin — where herdr's install.sh puts the binary — is
 * absent from PATH at boot, and the service exit-looped with
 * "herdr command not found" even though herdr was installed and running.
 */
describe('herdrBinaryPath', () => {
  it('resolves to an existing absolute path when herdr is installed', () => {
    const resolved = herdrBinaryPath();
    if (resolved === null) return; // herdr not installed on this machine
    expect(resolved.startsWith('/')).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  it('finds the install.sh location even when PATH omits it', () => {
    const installShPath = join(homedir(), '.local', 'bin', 'herdr');
    if (!existsSync(installShPath)) return; // not installed via install.sh here

    const prevPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin'; // systemd-like PATH, no ~/.local/bin
    try {
      // Re-resolve in a fresh module registry so the cached value doesn't hide
      // the PATH-independent fallback we're asserting on.
      delete require.cache?.[require.resolve('../herdr-client')];
      expect(existsSync(herdrBinaryPath() ?? '')).toBe(true);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('herdrBin falls back to the bare name so spawns still report a usable error', () => {
    expect(herdrBin().length).toBeGreaterThan(0);
  });
});
