// A conversation subscribed to before its transcript exists.
//
// Claude Code writes the transcript only once the first prompt goes in, and a
// new session is announced to herdr before that. A prompt sent from the chat
// view of a session made a moment ago is exactly that case.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationWatcher } from '../conversation-watcher';
import { claudeProjectDirName } from '../../utils/claude-project-path';

const home = mkdtempSync(join(tmpdir(), 'watcher-await-'));
const projectsDir = join(home, '.claude', 'projects');

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('a transcript that does not exist yet', () => {
  test('is picked up once it is written', async () => {
    const workingDir = join(home, 'project');
    mkdirSync(workingDir, { recursive: true });
    const id = '11111111-2222-3333-4444-555555555555';

    const watcher = new ConversationWatcher(projectsDir);
    expect(await watcher.start(workingDir, id)).toEqual([]);
    expect(watcher.getCcSessionId()).toBeNull();

    const found: string[] = [];
    const updates: number[] = [];
    watcher.onFound((ccSessionId) => found.push(ccSessionId));
    watcher.onUpdate((messages) => updates.push(messages.length));

    const dir = join(projectsDir, claudeProjectDirName(workingDir));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: id,
        cwd: workingDir,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'first prompt' },
      })}\n`,
    );

    const deadline = Date.now() + 6000;
    while (found.length === 0 && Date.now() < deadline) await Bun.sleep(100);
    watcher.stop();

    expect(found).toEqual([id]);
    expect(updates).toEqual([1]);
  }, 10000);
});
