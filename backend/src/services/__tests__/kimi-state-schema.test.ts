import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KimiHistoryService } from '../kimi-history';
import { KimiSessionStore } from '../kimi';

/**
 * Kimi Code has written `state.json` two ways, and both are on disk at once.
 *
 * 0.34 renamed `workDir` to `cwd` and turned the timestamps into epoch
 * milliseconds. The scan required `workDir`, so every session the new version
 * wrote was skipped before it reached the store: the Chat view answered "no
 * messages" for a session holding a full transcript, history stopped at the day
 * of the upgrade, and the usage tab under-reported by however much had been run
 * since.
 *
 * Nothing failed loudly - `getConversation` returns `[]` for a session it
 * cannot find, which is indistinguishable from an empty one.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A sessions root holding one session directory per spec. */
function buildSessions(specs: Array<{ project: string; id: string; state: unknown; wire?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'kimi-sessions-'));
  dirs.push(root);
  for (const spec of specs) {
    const dir = join(root, spec.project, spec.id);
    mkdirSync(join(dir, 'agents', 'main'), { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(spec.state));
    writeFileSync(join(dir, 'agents', 'main', 'wire.jsonl'), spec.wire ?? '');
  }
  return root;
}

/** One user prompt and one assistant reply, in the wire's own shape. */
const WIRE = [
  JSON.stringify({
    type: 'turn.prompt',
    input: [{ type: 'text', text: 'why is the chat empty' }],
    origin: { kind: 'user' },
  }),
  JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'content.part', part: { type: 'text', text: 'because the scan dropped the session' } },
  }),
].join('\n');

/** v1: `workDir`, ISO timestamps, no version marker. Kimi through 0.33. */
const V1_STATE = {
  id: 'session_v1',
  workDir: '/home/dev/old-project',
  createdAt: '2026-08-05T15:00:00.000Z',
  updatedAt: '2026-08-05T15:56:09.136Z',
  title: 'an older session',
};

/** v2: `cwd`, epoch milliseconds, `version: 2`. Kimi 0.34+. */
const V2_STATE = {
  id: 'session_v2',
  version: 2,
  cwd: '/home/dev/new-project',
  createdAt: 1786133431383,
  updatedAt: 1786134737147,
  title: 'a session written after the upgrade',
};

describe('kimi state.json schemas', () => {
  test('both schemas are found by one scan', async () => {
    const root = buildSessions([
      { project: 'wd_old_1111', id: 'session_v1', state: V1_STATE, wire: WIRE },
      { project: 'wd_new_2222', id: 'session_v2', state: V2_STATE, wire: WIRE },
    ]);
    const found = await new KimiSessionStore(root).listSessions();
    expect(found.map((s) => s.sessionId).sort()).toEqual(['session_v1', 'session_v2']);
  });

  test("v2's cwd is read where v1 wrote workDir", async () => {
    const root = buildSessions([{ project: 'wd_new_2222', id: 'session_v2', state: V2_STATE, wire: WIRE }]);
    const [session] = await new KimiSessionStore(root).listSessions();
    expect(session.cwd).toBe('/home/dev/new-project');
  });

  test('epoch milliseconds become the ISO string every consumer sorts and dates by', async () => {
    // `kimi-history.ts` calls `localeCompare` on this and `kimi-usage.ts` puts
    // it through `new Date()`. A number reaching either is a wrong answer with
    // no error to notice.
    const root = buildSessions([{ project: 'wd_new_2222', id: 'session_v2', state: V2_STATE, wire: WIRE }]);
    const [session] = await new KimiSessionStore(root).listSessions();
    expect(typeof session.updatedAt).toBe('string');
    expect(session.updatedAt).toBe(new Date(1786134737147).toISOString());
    expect(new Date(session.updatedAt).getTime()).toBe(1786134737147);
  });

  test('a v2 session has a conversation rather than an empty Chat view', async () => {
    const root = buildSessions([{ project: 'wd_new_2222', id: 'session_v2', state: V2_STATE, wire: WIRE }]);
    const history = new KimiHistoryService(new KimiSessionStore(root));
    const messages = await history.getConversation('session_v2');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'why is the chat empty' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'because the scan dropped the session' });
  });

  test('a session with no working directory in either field is still skipped', async () => {
    const root = buildSessions([
      { project: 'wd_broken_3333', id: 'session_broken', state: { version: 2, updatedAt: 1786134737147 } },
    ]);
    expect(await new KimiSessionStore(root).listSessions()).toEqual([]);
  });
});
