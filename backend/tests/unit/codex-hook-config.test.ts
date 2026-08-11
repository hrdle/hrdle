import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installCodexNotifyHooks,
  mergeNotifyHooksJson,
} from '../../src/services/codex-hook-config';
import { HOOK_COMMAND, IDENTITY } from '../../../shared/identity';

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Codex hook JSON', () => {
  test('preserves herdr SessionStart and adds only the hooks we require', () => {
    const result = JSON.parse(mergeNotifyHooksJson(JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'herdr-session-hook' }] }],
      },
    }), `/opt/${IDENTITY.binaryName} notify`));

    expect(result.hooks.SessionStart).toHaveLength(1);
    expect(result.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: `/opt/${IDENTITY.binaryName} notify` }] },
    ]);
    expect(result.hooks.PostToolUse).toEqual([{
      matcher: 'AskUserQuestion',
      hooks: [{ type: 'command', command: `/opt/${IDENTITY.binaryName} notify` }],
    }]);
    expect(result.hooks.PreToolUse).toBeUndefined();
    expect(result.hooks.UserPromptSubmit).toBeUndefined();
  });

  test('is idempotent and does not duplicate our existing entries', () => {
    const first = mergeNotifyHooksJson(null, HOOK_COMMAND);
    const second = mergeNotifyHooksJson(first, HOOK_COMMAND);
    expect(second).toBe(first);
  });

  test('writes hooks.json atomically and leaves unrelated hooks alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), `${IDENTITY.tmpPrefix}-codex-hook-install-`));
    scratchDirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'hooks.json'), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: 'herdr-hook' }] }],
      },
    }));

    const result = await installCodexNotifyHooks(dir);
    const hooks = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8'));

    expect(result.changed).toBe(true);
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe(result.command);
  });

  test('a second run changes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), `${IDENTITY.tmpPrefix}-codex-hook-install-`));
    scratchDirs.push(dir);
    await installCodexNotifyHooks(dir);

    expect((await installCodexNotifyHooks(dir)).changed).toBe(false);
  });
});
