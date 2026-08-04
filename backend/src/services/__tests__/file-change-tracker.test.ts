import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChangeTracker } from '../file-change-tracker';
import { claudeProjectDirName } from '../../utils/claude-project-path';

/**
 * Which transcript the Claude changes list reads.
 *
 * The view is addressed by working directory, and a project directory name is
 * only a guess at where that directory's transcript lives: the name is fixed
 * when the agent starts and the file never moves, so a `mv` of the working
 * directory leaves the pane naming a directory nothing was written to. The
 * lookup used to walk up to an ancestor from there and show the edits of
 * whatever ran in `/home` last.
 */
describe('file change tracker: which transcript the changes come from', () => {
  const HOME = '/home/fixture';
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

  test('an ancestor project is never mistaken for this directory', async () => {
    const { dir, write } = await projects();
    try {
      // Only the home directory has a transcript; the work directory has none.
      await write(HOME, 'aaaaaaaa-1111-2222-3333-444444444444', edit(HOME, '/home/fixture/notes.md', '2026-08-04T00:00:00.000Z'));

      const changes = await new FileChangeTracker(dir).getChangesForWorkingDir(WORK);
      expect(changes).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a renamed working directory still finds the session that is in it', async () => {
    const { dir, write } = await projects();
    try {
      // Filed under the name the directory had when the agent started, and its
      // records carry the name it has now.
      await write(
        OLD_NAME,
        'bbbbbbbb-5555-6666-7777-888888888888',
        edit(OLD_NAME, '/home/fixture/repos/work/early.ts', '2026-08-04T00:00:00.000Z') +
          edit(WORK, '/home/fixture/repos/work/late.ts', '2026-08-04T01:00:00.000Z'),
      );
      // An older, unrelated session elsewhere must not win the scan.
      await write(HOME, 'cccccccc-9999-0000-1111-222222222222', edit(HOME, '/home/fixture/notes.md', '2026-08-03T00:00:00.000Z'), 60_000);

      const changes = await new FileChangeTracker(dir).getChangesForWorkingDir(WORK);
      expect(changes.map((c) => c.path)).toEqual([
        '/home/fixture/repos/work/late.ts',
        '/home/fixture/repos/work/early.ts',
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
