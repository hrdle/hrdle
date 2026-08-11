import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeService } from '../claude-code';
import { claudeProjectDirName } from '../../utils/claude-project-path';

/**
 * Which transcript a conversation subscription reads.
 *
 * Two Claude panes in one workspace, in one directory, are two conversations
 * in one project folder. Resolving by directory answers with whichever wrote
 * last, so the pane on screen and the transcript beside it were routinely
 * different agents. The subscription now names the pane's own session id, and
 * this locks the difference between the two lookups.
 */
describe('conversation transcript resolution', () => {
  async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'hrdle-conv-'));
    // A name, not a place: nothing is read from here, it only decides
    // which project directory the transcripts hash into.
    const workDir = '/home/fixture/repos/work';
    const projectDir = join(home, '.claude', 'projects', claudeProjectDirName(workDir));
    await mkdir(projectDir, { recursive: true });

    const older = 'aaaaaaaa-1111-2222-3333-444444444444';
    const newer = 'bbbbbbbb-5555-6666-7777-888888888888';
    await writeFile(
      join(projectDir, `${older}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { content: 'pane one' } })}\n`,
    );
    await writeFile(
      join(projectDir, `${newer}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { content: 'pane two' } })}\n`,
    );
    // Make the ordering explicit rather than relying on write order.
    const past = new Date(Date.now() - 60_000);
    await utimes(join(projectDir, `${older}.jsonl`), past, past);

    return { home, workDir, older, newer };
  }

  // Bun caches os.homedir(), so pointing HOME at the fixture would not
  // redirect anything — the service takes the directory instead.
  const serviceFor = (home: string) =>
    new ClaudeCodeService(join(home, '.claude', 'projects'));

  test('by directory: the newest transcript wins, whichever pane wrote it', async () => {
    const { home, workDir, newer } = await fixture();
    try {
      const session = await serviceFor(home).getSessionForPath(workDir);
      expect(session?.sessionId).toBe(newer);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('by session id: the pane asked for is the pane answered, newer or not', async () => {
    const { home, workDir, older } = await fixture();
    try {
      const session = await serviceFor(home).getSessionById(older, workDir);
      expect(session?.sessionId).toBe(older);
      expect(session?.projectPath).toBe(workDir);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('an id with no transcript resolves to nothing, so the caller can fall back', async () => {
    const { home, workDir } = await fixture();
    try {
      const session = await serviceFor(home).getSessionById(
        'cccccccc-9999-0000-1111-222222222222',
        workDir,
      );
      expect(session).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * Rename the working directory under a running agent and the pane's cwd names
   * a project directory that was never written to. The transcript stays where
   * the agent started it. Resolving by directory then walked up to an ancestor
   * — `/home` — and answered with a stranger's conversation.
   */
  test('by session id: a renamed working directory still finds the transcript', async () => {
    const { home, older } = await fixture();
    try {
      const renamed = '/home/fixture/repos/work-renamed';
      const session = await serviceFor(home).getSessionById(older, renamed);
      expect(session?.sessionId).toBe(older);
      // The directory the transcript is in, not the one the pane is in now.
      expect(session?.projectDirName).toBe(claudeProjectDirName('/home/fixture/repos/work'));
      expect(session?.matchedById).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('a cwd whose project directory does not exist never answers with another session', async () => {
    const { home } = await fixture();
    try {
      const session = await serviceFor(home).getSessionById(
        'cccccccc-9999-0000-1111-222222222222',
        '/home/fixture/repos/work-renamed',
      );
      expect(session).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
