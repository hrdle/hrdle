import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeActivity } from '../agent-activity';

let dir: string;
let projects: string;

/** The transcript's own shape, one record per line. */
function call(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'activity-'));
  projects = join(dir, 'projects', '-home-dev-project');
  await mkdir(projects, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function transcript(lines: string[]): Promise<string> {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await writeFile(join(projects, `${id}.jsonl`), `${lines.join('\n')}\n`);
  return id;
}

describe('claudeActivity', () => {
  test('reports the newest call, not the first', async () => {
    const id = await transcript([
      call('Read', { file_path: '/home/dev/project/old.ts' }),
      call('Edit', { file_path: '/home/dev/project/src/components/StewardView.tsx' }),
    ]);
    // The file name alone: the directory is the session's own nine times in
    // ten, and on a phone it is the part that gets cut.
    expect(await claudeActivity(id, join(dir, 'projects'))).toEqual({
      tool: 'Edit',
      target: 'StewardView.tsx',
    });
  });

  test('a command is the command', async () => {
    const id = await transcript([call('Bash', { command: 'bun test src/' })]);
    expect(await claudeActivity(id, join(dir, 'projects'))).toEqual({
      tool: 'Bash',
      target: 'bun test src/',
    });
  });

  test('a command long enough for two lines arrives whole', async () => {
    // The length that used to be cut at 48, which is where the directory ended
    // and the command began.
    const command = 'cd /home/dev/repos/hrdle-work-3/backend/src && bun test services/';
    const id = await transcript([call('Bash', { command })]);
    expect(await claudeActivity(id, join(dir, 'projects'))).toEqual({
      tool: 'Bash',
      target: command,
    });
  });

  test('a runaway command is still cut - this rides on every sessions push', async () => {
    const id = await transcript([call('Bash', { command: `echo ${'x'.repeat(4000)}` })]);
    const activity = await claudeActivity(id, join(dir, 'projects'));
    expect(activity?.target?.length).toBeLessThanOrEqual(160);
    expect(activity?.target?.endsWith('…')).toBe(true);
  });

  test('a call naming nothing still names its tool', async () => {
    const id = await transcript([call('TodoWrite', { todos: [] })]);
    expect(await claudeActivity(id, join(dir, 'projects'))).toEqual({ tool: 'TodoWrite' });
  });

  test('a tail that opens mid-record does not throw', async () => {
    const id = await transcript(['{"type":"assis', call('Grep', { pattern: 'steward' })]);
    expect(await claudeActivity(id, join(dir, 'projects'))).toEqual({
      tool: 'Grep',
      target: 'steward',
    });
  });

  test('no transcript is not an error, it is no activity', async () => {
    expect(await claudeActivity('no-such-session', join(dir, 'projects'))).toBeUndefined();
  });
});
