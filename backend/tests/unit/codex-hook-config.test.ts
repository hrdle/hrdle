import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mergeCchubNotifyHooksJson,
  migrateCodexHooksToJson,
  removeCchubNotifyHooksToml,
} from '../../src/services/codex-hook-config';
import { HOOK_COMMAND, IDENTITY } from '../../../shared/identity';

// The path form is what setup actually writes (#538), so it is what the
// migration has to preserve. Both are built from identity so a rename moves
// them together instead of leaving the fixtures naming a binary nobody ships.
const ABSOLUTE = `/home/user/bin/${IDENTITY.binaryName} notify`;

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Codex hook JSON migration', () => {
  test('preserves herdr SessionStart and adds only the hooks we require', () => {
    const result = JSON.parse(mergeCchubNotifyHooksJson(JSON.stringify({
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
    const first = mergeCchubNotifyHooksJson(null, HOOK_COMMAND);
    const second = mergeCchubNotifyHooksJson(first, HOOK_COMMAND);
    expect(second).toBe(first);
  });

  test('removes only our notify hook entries from TOML', () => {
    const input = `model = "gpt-test"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "${ABSOLUTE}"

[[hooks.PostToolUse]]
matcher = "Bash"
[[hooks.PostToolUse.hooks]]
type = "command"
command = "keep-me"

[hooks.state]
[hooks.state."hooks.json:session_start:0:0"]
trusted_hash = "sha256:abc"
`;

    const result = removeCchubNotifyHooksToml(input);
    expect(result).toContain('model = "gpt-test"');
    expect(result).not.toContain(HOOK_COMMAND);
    expect(result).toContain('command = "keep-me"');
    expect(result).toContain('[hooks.state]');
    expect(result).toContain('hooks.json:session_start:0:0');
  });

  test('migrates files atomically and keeps the existing absolute command', async () => {
    const dir = await mkdtemp(join(tmpdir(), `${IDENTITY.tmpPrefix}-codex-hook-migration-`));
    scratchDirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.toml'), `model = "gpt-test"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
command = "${ABSOLUTE}"
`);
    await writeFile(join(dir, 'hooks.json'), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: 'herdr-hook' }] }],
      },
    }));

    const result = await migrateCodexHooksToJson(dir);
    const config = await readFile(join(dir, 'config.toml'), 'utf8');
    const hooks = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8'));

    expect(result).toEqual({ changed: true, command: ABSOLUTE });
    expect(config).toBe('model = "gpt-test"\n');
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe(ABSOLUTE);
  });
});
