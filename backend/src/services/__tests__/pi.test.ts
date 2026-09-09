import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexHerdrAgentPanes } from '../herdr';
import { parsePiTail, PiModelsStore, PiService, PiSessionStore, piSessionIdFromPath } from '../pi';
import { parsePiSession, PiHistoryService } from '../pi-history';
import { PiUsageService } from '../pi-usage';

// Shapes as pi 0.84 writes them, one record per line.
const ID = '01a0726e-d7d9-7217-b3f8-11a4c3fdb0cb';
const FILE = `2026-09-05T16-37-41-978Z_${ID}.jsonl`;

function usage(input: number, output: number, cost?: number) {
  return { input, output, cacheRead: 100, cacheWrite: 0, reasoning: 0, totalTokens: input + output + 100, ...(cost === undefined ? {} : { cost: { total: cost } }) };
}

function lines(at: string, opts: { cost?: number } = {}): string[] {
  return [
    { type: 'session', version: 3, id: ID, timestamp: '2026-09-05T16:37:41.978Z', cwd: '/Users/me/tmp/pi-hrdle-test' },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: at, provider: 'openai-codex', modelId: 'gpt-6-astra' },
    { type: 'custom', customType: 'git-checkpoint', data: { ref: 'abc' } },
    { type: 'message', id: 'u1', parentId: 'm1', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: '1+1 は? 数字だけ答えて' }] } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: at, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'trivial' }, { type: 'toolCall', id: 'call1', name: 'bash', arguments: { command: 'echo 2' } }], model: 'gpt-6-astra', provider: 'openai-codex', usage: usage(6000, 20, opts.cost) } },
    { type: 'message', id: 't1', parentId: 'a1', timestamp: at, message: { role: 'toolResult', toolCallId: 'call1', toolName: 'bash', content: [{ type: 'text', text: '2\n' }], isError: false } },
    { type: 'message', id: 'a2', parentId: 't1', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: '2' }], model: 'gpt-6-astra', provider: 'openai-codex', usage: usage(6100, 5, opts.cost) } },
  ].map((r) => JSON.stringify(r));
}

/** `~/.pi/agent/models-store.json` as pi 0.85 writes it: provider -> models with their windows. */
function modelsWith(extra: Record<string, { id: string; contextWindow?: number }[]> = {}): PiModelsStore {
  const providers = { 'openai-codex': [{ id: 'gpt-6-astra', contextWindow: 272000 }], ...extra };
  const path = join(mkdtempSync(join(tmpdir(), 'pi-models-')), 'models-store.json');
  writeFileSync(path, JSON.stringify(Object.fromEntries(Object.entries(providers).map(([p, models]) => [p, { models }]))));
  return new PiModelsStore(path);
}

function storeWith(at = new Date().toISOString(), opts: { cost?: number } = {}): { store: PiSessionStore; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-sessions-'));
  const dir = join(root, '--Users-me-tmp-pi-hrdle-test--');
  mkdirSync(dir);
  const path = join(dir, FILE);
  writeFileSync(path, `${lines(at, opts).join('\n')}\n`);
  writeFileSync(join(root, 'stray.txt'), 'not a session');
  return { store: new PiSessionStore(root), path };
}

describe('the session id is the file name', () => {
  test('after the timestamp', () => {
    expect(piSessionIdFromPath(`/x/${FILE}`)).toBe(ID);
  });
  test('and not from something that is not a session file', () => {
    expect(piSessionIdFromPath('/x/notes.txt')).toBeUndefined();
  });
  test("which is how herdr's path report becomes an address, for pi alone", () => {
    const panes = indexHerdrAgentPanes([
      { pane_id: 'w1:p1', agent: 'pi', agent_status: 'idle', agent_session: { kind: 'path', value: `/home/me/.pi/agent/sessions/--x--/${FILE}` } },
      { pane_id: 'w2:p1', agent: 'codex', agent_status: 'idle', agent_session: { kind: 'path', value: '/home/me/.codex/sessions/rollout.jsonl' } },
    ]);
    expect(panes.get('w1:p1')?.sessionId).toBe(ID);
    expect(panes.get('w2:p1')?.sessionId).toBeUndefined();
  });
});

describe('the session store', () => {
  test('reads the header and the first prompt without the rest', async () => {
    const { store, path } = storeWith();
    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: ID, cwd: '/Users/me/tmp/pi-hrdle-test', path, firstPrompt: '1+1 は? 数字だけ答えて', createdAt: '2026-09-05T16:37:41.978Z' });
  });

  test('a thread carries the latest answer and the context it sat in', async () => {
    const { store } = storeWith();
    const threads = await new PiService(store, modelsWith()).getThreadsByIds([ID, 'nope']);
    const thread = threads.get(ID);
    expect(thread?.recap).toBe('2');
    // The context is what pi itself counts: the usage's own total.
    expect(thread?.tokenUsage).toMatchObject({ model: 'gpt-6-astra', contextTokens: 6205, totalOutputTokens: 25 });
    expect(threads.has('nope')).toBe(false);
  });

  test('the context is measured against the window pi recorded for the model', async () => {
    const { store } = storeWith();
    const threads = await new PiService(store, modelsWith()).getThreadsByIds([ID]);
    expect(threads.get(ID)?.tokenUsage).toMatchObject({ contextMaxTokens: 272000, contextPercent: 2.3 });
  });

  test('a model pi has no window for leaves the percent absent rather than guessed', async () => {
    const { store } = storeWith();
    const threads = await new PiService(store, modelsWith({ 'openai-codex': [] })).getThreadsByIds([ID]);
    const usage = threads.get(ID)?.tokenUsage;
    expect(usage?.contextTokens).toBe(6205);
    expect(usage?.contextMaxTokens).toBeUndefined();
    expect(usage?.contextPercent).toBeUndefined();
  });
});

describe('the models store', () => {
  test('answers by provider and id, since ids repeat across providers', () => {
    const models = modelsWith({ openai: [{ id: 'gpt-6-astra', contextWindow: 128000 }] });
    expect(models.contextWindow('openai-codex', 'gpt-6-astra')).resolves.toBe(272000);
    expect(models.contextWindow('openai', 'gpt-6-astra')).resolves.toBe(128000);
    expect(models.contextWindow('xai', 'gpt-6-astra')).resolves.toBeUndefined();
  });
  test('a missing file is no windows at all', () => {
    expect(new PiModelsStore(join(tmpdir(), 'nowhere', 'models-store.json')).contextWindow('openai-codex', 'gpt-6-astra')).resolves.toBeUndefined();
  });
});

describe('the tail', () => {
  test('is the last assistant text, capped, and the usage summed over what was read', () => {
    const long = JSON.stringify({ type: 'message', id: 'a9', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(600) }], usage: usage(1, 1) } });
    const tail = parsePiTail([...lines('t'), long]);
    expect(tail.recap?.length).toBe(503);
    expect(tail.recap?.endsWith('...')).toBe(true);
    expect(tail.tokenUsage?.totalTokens).toBe(6000 + 100 + 20 + 6100 + 100 + 5 + 1 + 100 + 1);
  });
  test('nothing without an assistant turn', () => {
    expect(parsePiTail(lines('t').slice(0, 4))).toEqual({ tokenUsage: undefined, provider: undefined, recap: undefined, recapAt: undefined });
  });
  test('after a compaction the context is unknown until the next answer', () => {
    const compaction = JSON.stringify({ type: 'compaction', id: 'c1', timestamp: 't', summary: 'so far' });
    const tail = parsePiTail([...lines('t'), compaction]);
    expect(tail.tokenUsage?.contextTokens).toBeUndefined();
    expect(tail.tokenUsage?.totalOutputTokens).toBe(25);
    expect(tail.recap).toBe('2');
    const answered = parsePiTail([...lines('t'), compaction, lines('t')[6]]);
    expect(answered.tokenUsage?.contextTokens).toBe(6205);
  });
});

describe('the conversation', () => {
  test('pairs a tool call with its result across the turn boundary', () => {
    const messages = parsePiSession(lines('t').join('\n'));
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[1].toolUse).toEqual([{ id: 'call1', name: 'bash', input: { command: 'echo 2' } }]);
    expect(messages[1].thinking).toBe('trivial');
    expect(messages[2].toolResult).toEqual([{ toolUseId: 'call1', toolName: 'bash', output: '2\n' }]);
    expect(messages[3].content).toBe('2');
  });
  test('settings changes and extension records are not turns', () => {
    expect(parsePiSession(lines('t').slice(0, 3).join('\n'))).toEqual([]);
  });
  test('an errored result and an image reach the viewer as such', () => {
    const text = JSON.stringify({ type: 'message', id: 't2', timestamp: 't', message: { role: 'toolResult', toolCallId: 'c', toolName: 'view', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }], isError: true } });
    const [m] = parsePiSession(text);
    expect(m.toolResult?.[0]).toMatchObject({ isError: true, images: [{ mediaType: 'image/jpeg', data: 'AAAA' }] });
  });
});

describe('history', () => {
  test('groups sessions by the Claude project directory name of their cwd', async () => {
    const { store } = storeWith();
    const history = new PiHistoryService(store);
    const projects = await history.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].projectPath).toBe('/Users/me/tmp/pi-hrdle-test');
    const sessions = await history.getProjectSessions(projects[0].dirName);
    expect(sessions[0]).toMatchObject({ sessionId: ID, agent: 'pi', firstPrompt: '1+1 は? 数字だけ答えて' });
    expect(await history.searchSessions('数字')).toHaveLength(1);
    expect((await history.getConversation(ID)).length).toBe(4);
    expect(await history.getConversation('nope')).toEqual([]);
  });
});

describe('usage', () => {
  test('counts assistant turns in the windows, with the cost pi recorded', async () => {
    const { store } = storeWith(new Date().toISOString(), { cost: 0.03 });
    const summary = await new PiUsageService(store).getUsageSummary();
    expect(summary?.last24h.turns).toBe(2);
    expect(summary?.last7d.costUsd).toBeCloseTo(0.06, 6);
    expect(summary?.models[0]).toMatchObject({ model: 'gpt-6-astra' });
    expect(summary?.sessions7d).toBe(1);
  });
  test('a turn without a cost leaves the cost absent rather than zero', async () => {
    const { store } = storeWith();
    const summary = await new PiUsageService(store).getUsageSummary();
    expect(summary?.last7d.costUsd).toBeUndefined();
  });
  test('turns older than the window are not in it', async () => {
    const { store } = storeWith('2020-01-01T00:00:00.000Z');
    expect(await new PiUsageService(store).getUsageSummary()).toBeNull();
  });
});
