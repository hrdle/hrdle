import { describe, expect, test } from 'bun:test';
import { notifyCommandFor } from '../notify-command';
import { mergeCchubNotifyHooksJson } from '../codex-hook-config';
import { parseHookJson } from '../hook-status';

/**
 * #538: hooks run in a non-interactive shell, which never sources `.zshrc`.
 * A `~/bin` install that got its PATH entry there is invisible to the hook, so
 * a bare `cchub notify` dies with `command not found` and notifications stop
 * without a word. What CC Hub writes itself has to carry its own path.
 */
describe('notifyCommandFor', () => {
  test('an installed binary is invoked by absolute path', () => {
    expect(notifyCommandFor('/home/me/bin/cchub')).toBe('/home/me/bin/cchub notify');
  });

  test('a path with spaces is quoted, since hook commands go through a shell', () => {
    expect(notifyCommandFor('/Users/me/My Tools/cchub')).toBe('"/Users/me/My Tools/cchub" notify');
  });

  test('running from source falls back to the bare name', () => {
    // `bun run src/index.ts` makes execPath the bun binary, and `<bun> notify`
    // is not a command. Dev is also where PATH is least likely to be broken.
    expect(notifyCommandFor('/home/me/.bun/bin/bun')).toBe('cchub notify');
    expect(notifyCommandFor('/usr/local/bin/node')).toBe('cchub notify');
  });
});

describe('an absolute command still reads as configured', () => {
  test('the hook CC Hub writes is recognized as its own', () => {
    const written = mergeCchubNotifyHooksJson(null, '/home/me/bin/cchub notify');
    expect(parseHookJson(written)).toEqual({ stop: true, askUserQuestion: true });
  });

  test('and writing again does not add a second copy', () => {
    const once = mergeCchubNotifyHooksJson(null, '/home/me/bin/cchub notify');
    expect(mergeCchubNotifyHooksJson(once, '/home/me/bin/cchub notify')).toBe(once);
  });
});
