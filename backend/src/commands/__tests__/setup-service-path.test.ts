import { afterEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildServicePath } from '../setup';

/**
 * supervised systemd units launch via `zsh -lc` (login, non-interactive),
 * which does NOT source `.zshrc`. Users add `~/.local/bin` / `~/bin` to PATH
 * there, so the server and its spawned hooks lose those dirs and fail with
 * `command not found`. buildServicePath() bakes a complete PATH for the unit,
 * guaranteeing the two home bin dirs are present regardless of inherited PATH.
 */

const ORIGINAL_PATH = process.env.PATH;

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
});

describe('buildServicePath', () => {
  const home = homedir();
  const localBin = join(home, '.local', 'bin');
  const homeBin = join(home, 'bin');

  test('prepends ~/.local/bin and ~/bin even when the inherited PATH omits them', () => {
    process.env.PATH = '/usr/local/bin:/usr/bin';
    const dirs = buildServicePath().split(':');
    expect(dirs[0]).toBe(localBin);
    expect(dirs[1]).toBe(homeBin);
    expect(dirs).toContain('/usr/bin');
  });

  test('does not duplicate the home bin dirs already present in PATH', () => {
    process.env.PATH = `${homeBin}:${localBin}:/usr/bin`;
    const dirs = buildServicePath().split(':');
    expect(dirs.filter((d) => d === localBin)).toHaveLength(1);
    expect(dirs.filter((d) => d === homeBin)).toHaveLength(1);
  });

  test('falls back to standard dirs when PATH is empty', () => {
    process.env.PATH = '';
    const dirs = buildServicePath().split(':');
    expect(dirs).toEqual([localBin, homeBin, '/usr/local/bin', '/usr/bin', '/bin']);
  });

  test('escapes % so systemd does not treat it as a unit specifier', () => {
    process.env.PATH = '/opt/we%rd/bin';
    expect(buildServicePath()).toContain('/opt/we%%rd/bin');
  });
});
