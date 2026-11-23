import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChangeTracker } from '../file-change-tracker';
import { claudeProjectDirName } from '../../utils/claude-project-path';

/**
 * Which transcript the Claude changes list reads.
 *
 * Only the one the pane's session id names. Two sessions can share a working
 * directory, so the directory alone never decides.
 */
describe('file change tracker: which transcript the changes come from', () => {
  const WORK = '/home/fixture/repos/work';
  const OLD_NAME = '/home/fixture/repos/work-before-rename';

  function edit(cwd: string, path: string, timestamp: string): string {
    return `${JSON.stringify({
      type: 'assistant',
      cwd,
      timestamp,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: path, old_string: 'a', new_string: 'b' },
          },
        ],
      },
    })}\n`;
  }

  async function projects(): Promise<{ dir: string; write: (workDir: string, sessionId: string, body: string, ageMs?: number) => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), 'hrdle-changes-'));
    const write = async (workDir: string, sessionId: string, body: string, ageMs = 0) => {
      const projectDir = join(dir, claudeProjectDirName(workDir));
      await mkdir(projectDir, { recursive: true });
      const filePath = join(projectDir, `${sessionId}.jsonl`);
      await writeFile(filePath, body);
      if (ageMs > 0) {
        const past = new Date(Date.now() - ageMs);
        await utimes(filePath, past, past);
      }
    };
    return { dir, write };
  }

  test('two sessions in one directory each get their own changes', async () => {
    const { dir, write } = await projects();
    try {
      const mine = 'aaaaaaaa-1111-2222-3333-444444444444';
      const theirs = 'bbbbbbbb-5555-6666-7777-888888888888';
      await write(WORK, mine, edit(WORK, '/home/fixture/repos/work/mine.ts', '2026-08-04T00:00:00.000Z'), 60_000);
      // Newer, so a lookup by directory would have answered with this one.
      await write(WORK, theirs, edit(WORK, '/home/fixture/repos/work/theirs.ts', '2026-08-04T01:00:00.000Z'));

      const tracker = new FileChangeTracker(dir);
      expect((await tracker.getChangesForSessionId(WORK, mine)).map((c) => c.path)).toEqual([
        '/home/fixture/repos/work/mine.ts',
      ]);
      expect((await tracker.getChangesForSessionId(WORK, theirs)).map((c) => c.path)).toEqual([
        '/home/fixture/repos/work/theirs.ts',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('one entry per file, newest first', async () => {
    const { dir, write } = await projects();
    try {
      const id = 'cccccccc-9999-0000-1111-222222222222';
      await write(
        WORK,
        id,
        edit(WORK, '/home/fixture/repos/work/a.ts', '2026-08-04T00:00:00.000Z') +
          edit(WORK, '/home/fixture/repos/work/b.ts', '2026-08-04T01:00:00.000Z') +
          edit(WORK, '/home/fixture/repos/work/a.ts', '2026-08-04T02:00:00.000Z'),
      );
      const changes = await new FileChangeTracker(dir).getChangesForSessionId(WORK, id);
      expect(changes.map((c) => [c.path, c.timestamp])).toEqual([
        ['/home/fixture/repos/work/a.ts', '2026-08-04T02:00:00.000Z'],
        ['/home/fixture/repos/work/b.ts', '2026-08-04T01:00:00.000Z'],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('by session id: a renamed working directory still finds the transcript', async () => {
    const { dir, write } = await projects();
    try {
      const sessionId = 'bbbbbbbb-5555-6666-7777-888888888888';
      await write(OLD_NAME, sessionId, edit(WORK, '/home/fixture/repos/work/late.ts', '2026-08-04T01:00:00.000Z'));

      const changes = await new FileChangeTracker(dir).getChangesForSessionId(WORK, sessionId);
      expect(changes.map((c) => c.path)).toEqual(['/home/fixture/repos/work/late.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
