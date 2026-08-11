import { describe, expect, test } from 'bun:test';
import { notifyCommandFor } from '../notify-command';
import { mergeNotifyHooksJson } from '../codex-hook-config';
import { parseHookJson } from '../hook-status';
import { HOOK_COMMAND, IDENTITY } from '../../../../shared/identity';

/**
 * hooks run in a non-interactive shell, which never sources `.zshrc`.
 * A `~/bin` install that got its PATH entry there is invisible to the hook, so
 * a bare `hrdle notify` dies with `command not found` and notifications stop
 * without a word. What we write ourselves has to carry its own path.
 */
const INSTALLED = `/home/me/bin/${IDENTITY.binaryName}`;

describe('notifyCommandFor', () => {
  test('an installed binary is invoked by absolute path', () => {
    expect(notifyCommandFor(INSTALLED)).toBe(`${INSTALLED} notify`);
  });

  test('a path with spaces is quoted, since hook commands go through a shell', () => {
    expect(notifyCommandFor(`/Users/me/My Tools/${IDENTITY.binaryName}`)).toBe(
      `"/Users/me/My Tools/${IDENTITY.binaryName}" notify`,
    );
  });

  test('running from source falls back to the bare name', () => {
    // `bun run src/index.ts` makes execPath the bun binary, and `<bun> notify`
    // is not a command. Dev is also where PATH is least likely to be broken.
    expect(notifyCommandFor('/home/me/.bun/bin/bun')).toBe(HOOK_COMMAND);
    expect(notifyCommandFor('/usr/local/bin/node')).toBe(HOOK_COMMAND);
  });
});

describe('an absolute command still reads as configured', () => {
  test('the hook we write is recognized as our own', () => {
    const written = mergeNotifyHooksJson(null, `${INSTALLED} notify`);
    expect(parseHookJson(written)).toEqual({ stop: true, askUserQuestion: true });
  });

  test('and writing again does not add a second copy', () => {
    const once = mergeNotifyHooksJson(null, `${INSTALLED} notify`);
    expect(mergeNotifyHooksJson(once, `${INSTALLED} notify`)).toBe(once);
  });
});
