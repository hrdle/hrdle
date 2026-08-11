import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GrokService, GrokSessionStore, readLatestGrokTokenUsage } from '../../src/services/grok';
import { GrokHistoryService, parseGrokChatHistory } from '../../src/services/grok-history';
import { claudeProjectDirName } from '../../src/utils/claude-project-path';

const TEST_DIR = join(tmpdir(), `hrdle-grok-service-${Date.now()}`);
const SESSIONS_DIR = join(TEST_DIR, 'sessions');

const CWD = '/home/user/my-project';
// Grok percent-encodes the cwd for the project directory name.
const ENCODED_CWD = encodeURIComponent(CWD);
const SESSION_ID = '019f7599-9759-78b1-9141-e8f187717ba5';

function summaryJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    info: { id: SESSION_ID, cwd: CWD },
    session_summary: 'Run the shell command: echo hello',
    created_at: '2026-07-18T14:20:27.905723571Z',
    updated_at: '2026-07-18T14:21:00.578011476Z',
    last_active_at: '2026-07-18T14:21:00.578011476Z',
    num_messages: 12,
    current_model_id: 'grok-4.5',
    generated_title: 'Run the shell command: echo hello',
    ...overrides,
  });
}

// Verbatim record shapes from a real grok 0.2.103 chat_history.jsonl.
const CHAT_HISTORY = [
  JSON.stringify({ type: 'system', content: 'You are Grok 4.5 released by xAI.' }),
  JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'env context' }] }),
  JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'CLAUDE.md contents' }], synthetic_reason: 'project_instructions' }),
  JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'reminder' }], synthetic_reason: 'system_reminder' }),
  JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nRun the shell command: echo hello\n</user_query>' }], prompt_index: 0 }),
  JSON.stringify({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'xxxx', status: 'completed' }),
  JSON.stringify({
    type: 'assistant',
    content: '',
    tool_calls: [{ id: 'call-1-0', name: 'run_terminal_command', arguments: '{"command":"echo hello"}' }],
    model_id: 'grok-4.5-build-free',
  }),
  JSON.stringify({ type: 'tool_result', tool_call_id: 'call-1-0', content: 'exit: 0\nhello\n' }),
  JSON.stringify({ type: 'assistant', content: 'It printed `hello`.', model_id: 'grok-4.5-build-free' }),
].join('\n');

const UPDATES_JSONL = [
  JSON.stringify({
    timestamp: 1784383666,
    method: 'session/update',
    params: { sessionId: SESSION_ID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'It printed' } } },
  }),
  JSON.stringify({
    timestamp: 1784383667,
    method: 'session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'p-1',
        stop_reason: 'end_turn',
        usage: { inputTokens: 26109, outputTokens: 83, totalTokens: 26192, cachedReadTokens: 0 },
      },
    },
  }),
].join('\n');

beforeEach(async () => {
  const sessionDir = join(SESSIONS_DIR, ENCODED_CWD, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'summary.json'), summaryJson());
  await writeFile(join(sessionDir, 'chat_history.jsonl'), CHAT_HISTORY);
  await writeFile(join(sessionDir, 'updates.jsonl'), UPDATES_JSONL);
  await writeFile(
    join(SESSIONS_DIR, ENCODED_CWD, 'prompt_history.jsonl'),
    `${JSON.stringify({ timestamp: '2026-07-18T14:20:29Z', session_id: SESSION_ID, prompt: 'Run the shell command: echo hello. Then report.', is_bash: false })}\n`,
  );
  // Non-project files that live alongside the encoded dirs must be skipped.
  await writeFile(join(SESSIONS_DIR, 'session_search.sqlite'), '');
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('parseGrokChatHistory', () => {
  test('collapses records into Claude-shaped turns', () => {
    const messages = parseGrokChatHistory(CHAT_HISTORY);
    expect(messages).toHaveLength(4);

    // Real prompt only (system / synthetic / no-index user records dropped),
    // with the <user_query> wrapper stripped.
    expect(messages[0]).toEqual({ role: 'user', content: 'Run the shell command: echo hello' });

    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.toolUse).toEqual([
      { id: 'call-1-0', name: 'run_terminal_command', input: { command: 'echo hello' } },
    ]);

    expect(messages[2]?.role).toBe('user');
    expect(messages[2]?.toolResult).toEqual([
      { toolUseId: 'call-1-0', toolName: 'run_terminal_command', output: 'exit: 0\nhello\n' },
    ]);

    expect(messages[3]).toEqual({ role: 'assistant', content: 'It printed `hello`.' });
  });

  test('returns empty for garbage input', () => {
    expect(parseGrokChatHistory('not json\n{"type":"reasoning"}')).toEqual([]);
  });
});

describe('GrokService', () => {
  test('resolves an exact thread by native session id with token usage', async () => {
    const service = new GrokService(new GrokSessionStore(SESSIONS_DIR));
    const threads = await service.getThreadsByIds([SESSION_ID, 'nonexistent']);
    expect(threads.size).toBe(1);
    const thread = threads.get(SESSION_ID);
    expect(thread?.sessionId).toBe(SESSION_ID);
    expect(thread?.title).toBe('Run the shell command: echo hello');
    expect(thread?.firstPrompt).toBe('Run the shell command: echo hello. Then report.');
    expect(thread?.tokenUsage?.totalTokens).toBe(26192);
    expect(thread?.tokenUsage?.totalOutputTokens).toBe(83);
  });

  test('returns empty map when the sessions dir does not exist', async () => {
    const service = new GrokService(new GrokSessionStore(join(TEST_DIR, 'missing')));
    expect((await service.getThreadsByIds([SESSION_ID])).size).toBe(0);
  });
});

describe('readLatestGrokTokenUsage', () => {
  test('reads usage from the last turn_completed record', () => {
    const usage = readLatestGrokTokenUsage(join(SESSIONS_DIR, ENCODED_CWD, SESSION_ID));
    expect(usage).toEqual({
      totalInputTokens: 26109,
      totalOutputTokens: 83,
      totalCacheReadTokens: 0,
      totalTokens: 26192,
    });
  });
});

describe('GrokHistoryService', () => {
  test('groups sessions into Claude-encoded project buckets', async () => {
    const service = new GrokHistoryService(new GrokSessionStore(SESSIONS_DIR));
    const projects = await service.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.dirName).toBe(claudeProjectDirName(CWD));
    expect(projects[0]?.projectPath).toBe(CWD);
    expect(projects[0]?.sessionCount).toBe(1);
  });

  test('lists project sessions tagged agent=grok', async () => {
    const service = new GrokHistoryService(new GrokSessionStore(SESSIONS_DIR));
    const sessions = await service.getProjectSessions(claudeProjectDirName(CWD));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(SESSION_ID);
    expect(sessions[0]?.agent).toBe('grok');
    expect(sessions[0]?.firstPrompt).toBe('Run the shell command: echo hello. Then report.');
  });

  test('search matches cwd and prompts', async () => {
    const service = new GrokHistoryService(new GrokSessionStore(SESSIONS_DIR));
    expect(await service.searchSessions('echo hello')).toHaveLength(1);
    expect(await service.searchSessions('no-such-text')).toHaveLength(0);
  });

  test('reads a conversation by session id', async () => {
    const service = new GrokHistoryService(new GrokSessionStore(SESSIONS_DIR));
    const messages = await service.getConversation(SESSION_ID);
    expect(messages).toHaveLength(4);
    expect(await service.getConversation('unknown-id')).toEqual([]);
  });
});
