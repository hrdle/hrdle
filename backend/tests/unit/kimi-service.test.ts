import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KimiService, KimiSessionStore, parseKimiRecap, readLatestKimiTokenUsage } from '../../src/services/kimi';
import { KimiHistoryService, parseKimiWire } from '../../src/services/kimi-history';
import { claudeProjectDirName } from '../../src/utils/claude-project-path';

const TEST_DIR = join(tmpdir(), `hrdle-kimi-service-${Date.now()}`);
const SESSIONS_DIR = join(TEST_DIR, 'sessions');

const CWD = '/home/user/my-project';
// Kimi names project dirs `wd_<basename>_<hexhash>`; the hash is opaque to us.
const WD_DIR = 'wd_my-project_58f1d424d923';
const SESSION_ID = 'session_019f7599-9759-78b1-9141-e8f187717ba5';

function stateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    createdAt: '2026-07-19T12:01:01.293Z',
    updatedAt: '2026-07-19T12:01:01.332Z',
    title: 'Run the shell command: echo hello',
    isCustomTitle: false,
    agents: { main: { type: 'main', parentAgentId: null } },
    workDir: CWD,
    lastPrompt: 'Run the shell command: echo hello',
    ...overrides,
  });
}

// Verbatim record shapes from a real kimi 0.27.0 wire.jsonl.
const WIRE_JSONL = [
  JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1784463029095 }),
  JSON.stringify({ type: 'config.update', modelAlias: 'k3', thinkingEffort: 'off', time: 1784463029095 }),
  JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'Run the shell command: echo hello' }], origin: { kind: 'user' }, time: 1784463056815 }),
  // Duplicates the turn.prompt payload — must not produce a second user turn.
  JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'Run the shell command: echo hello' }], toolCalls: [], origin: { kind: 'user' } }, time: 1784463056816 }),
  // Injected context — not conversation.
  JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>auto mode</system-reminder>' }], toolCalls: [], origin: { kind: 'injection' } }, time: 1784463056817 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's-1', turnId: '0', step: 1 }, time: 1784463056819 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'p-1', turnId: '0', step: 1, part: { type: 'think', think: 'The user wants echo hello.' } }, time: 1784463057000 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'p-2', turnId: '0', step: 1, part: { type: 'text', text: "I'll run that." } }, time: 1784463057001 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', uuid: 'Bash_0', turnId: '0', step: 1, toolCallId: 'Bash_0', name: 'Bash', args: { command: 'echo hello' }, description: 'Running echo hello' }, time: 1784463057002 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.result', parentUuid: 'Bash_0', toolCallId: 'Bash_0', result: { output: 'exit: 0\nhello\n' } }, time: 1784463057100 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'p-3', turnId: '0', step: 1, part: { type: 'text', text: 'It printed `hello`.' } }, time: 1784463057200 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's-1', turnId: '0', step: 1, usage: { inputOther: 2559, output: 1085, inputCacheRead: 52480, inputCacheCreation: 0 }, finishReason: 'end_turn' }, time: 1784463057300 }),
  JSON.stringify({ type: 'usage.record', model: 'k3', usage: { inputOther: 2559, output: 1085, inputCacheRead: 52480, inputCacheCreation: 0 }, usageScope: 'turn', time: 1784463057301 }),
].join('\n');

beforeEach(async () => {
  const sessionDir = join(SESSIONS_DIR, WD_DIR, SESSION_ID);
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  await writeFile(join(sessionDir, 'state.json'), stateJson());
  await writeFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), WIRE_JSONL);
  // Sub-agent wires are not part of the conversation and must be ignored.
  await mkdir(join(sessionDir, 'agents', 'agent-0'), { recursive: true });
  await writeFile(join(sessionDir, 'agents', 'agent-0', 'wire.jsonl'), '{"type":"turn.prompt"}\n');
  // Non-project files that live alongside the wd_* dirs must be skipped.
  await writeFile(join(SESSIONS_DIR, 'session_index.jsonl'), `${JSON.stringify({ sessionId: SESSION_ID, sessionDir, workDir: CWD })}\n`);
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('parseKimiWire', () => {
  test('collapses records into Claude-shaped turns', () => {
    const messages = parseKimiWire(WIRE_JSONL);
    expect(messages).toHaveLength(4);

    // Real prompt only; the append_message duplicate / injection is dropped.
    expect(messages[0]).toEqual({ role: 'user', content: 'Run the shell command: echo hello' });

    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toBe("I'll run that.");
    expect(messages[1]?.toolUse).toEqual([
      { id: 'Bash_0', name: 'Bash', input: { command: 'echo hello' } },
    ]);

    expect(messages[2]?.role).toBe('user');
    expect(messages[2]?.toolResult).toEqual([
      { toolUseId: 'Bash_0', toolName: 'Bash', output: 'exit: 0\nhello\n' },
    ]);

    expect(messages[3]).toEqual({ role: 'assistant', content: 'It printed `hello`.' });
  });

  test('returns empty for garbage input', () => {
    expect(parseKimiWire('not json\n{"type":"metadata"}')).toEqual([]);
  });
});

describe('KimiSessionStore', () => {
  test('lists sessions with metadata from state.json and first prompt from the wire', async () => {
    const store = new KimiSessionStore(SESSIONS_DIR);
    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(SESSION_ID);
    expect(sessions[0]?.cwd).toBe(CWD);
    expect(sessions[0]?.title).toBe('Run the shell command: echo hello');
    expect(sessions[0]?.firstPrompt).toBe('Run the shell command: echo hello');
    expect(sessions[0]?.updatedAt).toBe('2026-07-19T12:01:01.332Z');
  });

  test('findSession resolves by the session_<uuid> dir name', async () => {
    const store = new KimiSessionStore(SESSIONS_DIR);
    expect((await store.findSession(SESSION_ID))?.cwd).toBe(CWD);
    expect(await store.findSession('session_missing')).toBeUndefined();
  });

  test('returns empty when the sessions dir does not exist', async () => {
    const store = new KimiSessionStore(join(TEST_DIR, 'missing'));
    expect(await store.listSessions()).toEqual([]);
  });
});

describe('KimiService', () => {
  test('resolves an exact thread by native session id with token usage', async () => {
    const service = new KimiService(new KimiSessionStore(SESSIONS_DIR));
    const threads = await service.getThreadsByIds([SESSION_ID, 'nonexistent']);
    expect(threads.size).toBe(1);
    const thread = threads.get(SESSION_ID);
    expect(thread?.sessionId).toBe(SESSION_ID);
    expect(thread?.title).toBe('Run the shell command: echo hello');
    expect(thread?.firstPrompt).toBe('Run the shell command: echo hello');
    expect(thread?.cwd).toBe(CWD);
    expect(thread?.tokenUsage?.model).toBe('k3');
    expect(thread?.tokenUsage?.totalTokens).toBe(56124);
    expect(thread?.tokenUsage?.totalOutputTokens).toBe(1085);
  });

  test('exposes the last assistant text part as the recap substitute', async () => {
    const service = new KimiService(new KimiSessionStore(SESSIONS_DIR));
    const thread = (await service.getThreadsByIds([SESSION_ID])).get(SESSION_ID);
    // The fixture's last text part is followed by step.end + usage.record —
    // the recap must still be found behind them.
    expect(thread?.recap).toBe('It printed `hello`.');
    expect(thread?.recapAt).toBe(new Date(1784463057200).toISOString());
  });

  test('returns empty map when the sessions dir does not exist', async () => {
    const service = new KimiService(new KimiSessionStore(join(TEST_DIR, 'missing')));
    expect((await service.getThreadsByIds([SESSION_ID])).size).toBe(0);
  });
});

describe('parseKimiRecap', () => {
  function partLine(kind: 'text' | 'think', text: string, time: number): string {
    return JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'content.part', part: kind === 'text' ? { type: 'text', text } : { type: 'think', think: text } },
      time,
    });
  }

  test('returns the last text part, ignoring later think parts', () => {
    const lines = [
      partLine('text', 'The answer.', 1784463057000),
      partLine('think', 'later reasoning', 1784463058000),
    ];
    expect(parseKimiRecap(lines)).toEqual({
      recap: 'The answer.',
      recapAt: new Date(1784463057000).toISOString(),
    });
  });

  test('returns no recap for a think-only wire', () => {
    const lines = [partLine('think', 'only reasoning', 1784463057000)];
    expect(parseKimiRecap(lines)).toEqual({});
  });

  test('truncates a long recap to 500 chars with an ellipsis', () => {
    const lines = [partLine('text', 'x'.repeat(600), 1784463057000)];
    const { recap } = parseKimiRecap(lines);
    expect(recap).toHaveLength(501);
    expect(recap?.endsWith('…')).toBe(true);
  });

  test('finds the recap when a usage.record follows the text part', () => {
    const lines = [
      partLine('text', 'Done.', 1784463057000),
      JSON.stringify({ type: 'usage.record', model: 'k3', usage: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: 'turn', time: 1784463057999 }),
    ];
    expect(parseKimiRecap(lines)).toEqual({
      recap: 'Done.',
      recapAt: new Date(1784463057000).toISOString(),
    });
  });
});

describe('readLatestKimiTokenUsage', () => {
  test('reads usage from the last usage.record record', () => {
    const usage = readLatestKimiTokenUsage(join(SESSIONS_DIR, WD_DIR, SESSION_ID));
    expect(usage).toEqual({
      model: 'k3',
      totalInputTokens: 55039,
      totalCacheReadTokens: 52480,
      totalOutputTokens: 1085,
      totalTokens: 56124,
    });
  });
});

describe('KimiHistoryService', () => {
  test('groups sessions into Claude-encoded project buckets', async () => {
    const service = new KimiHistoryService(new KimiSessionStore(SESSIONS_DIR));
    const projects = await service.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.dirName).toBe(claudeProjectDirName(CWD));
    expect(projects[0]?.projectPath).toBe(CWD);
    expect(projects[0]?.sessionCount).toBe(1);
  });

  test('lists project sessions tagged agent=kimi', async () => {
    const service = new KimiHistoryService(new KimiSessionStore(SESSIONS_DIR));
    const sessions = await service.getProjectSessions(claudeProjectDirName(CWD));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(SESSION_ID);
    expect(sessions[0]?.agent).toBe('kimi');
    expect(sessions[0]?.firstPrompt).toBe('Run the shell command: echo hello');
  });

  test('search matches cwd and prompts', async () => {
    const service = new KimiHistoryService(new KimiSessionStore(SESSIONS_DIR));
    expect(await service.searchSessions('echo hello')).toHaveLength(1);
    expect(await service.searchSessions('no-such-text')).toHaveLength(0);
  });

  test('reads a conversation by session id', async () => {
    const service = new KimiHistoryService(new KimiSessionStore(SESSIONS_DIR));
    const messages = await service.getConversation(SESSION_ID);
    expect(messages).toHaveLength(4);
    expect(await service.getConversation('unknown-id')).toEqual([]);
  });
});
