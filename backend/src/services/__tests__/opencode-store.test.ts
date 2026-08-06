import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeService, OpenCodeSessionStore, contextTokensOf, parseMessageTokens, parseSessionModel } from '../opencode';
import { OpenCodeHistoryService, parseOpenCodeMessages } from '../opencode-history';
import { OpenCodeUsageService } from '../opencode-usage';

/**
 * OpenCode 1.18 keeps sessions, messages and parts as rows in one SQLite
 * database. These fixtures reproduce the subset of its schema the reader
 * touches, with rows shaped exactly as observed on a real install: message
 * bodies carry role and tokens but no text, and every visible string lives on a
 * `part` row discriminated by `type`.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface PartSpec {
  messageId: string;
  data: unknown;
  timeCreated: number;
}

function buildDb(options: {
  sessions: Array<Record<string, unknown>>;
  messages: Array<{ id: string; sessionId: string; timeCreated: number; data: unknown }>;
  parts: PartSpec[];
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-test-'));
  dirs.push(dir);
  const dbPath = join(dir, 'opencode.db');
  const db = new Database(dbPath, { create: true });

  db.run(`CREATE TABLE session (
    id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text,
    directory text NOT NULL, title text NOT NULL, version text,
    cost real DEFAULT 0 NOT NULL,
    tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
    tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
    tokens_cache_write integer DEFAULT 0 NOT NULL, agent text, model text,
    time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer
  )`);
  db.run(`CREATE TABLE message (
    id text PRIMARY KEY, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  )`);
  db.run(`CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  )`);

  for (const session of options.sessions) {
    db.run(
      `INSERT INTO session (id, project_id, parent_id, directory, title, cost,
        tokens_input, tokens_output, tokens_cache_read, model, time_created, time_updated, time_archived)
       VALUES (?, 'global', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id as string,
        (session.parentId as string | null) ?? null,
        session.directory as string,
        (session.title as string) ?? '',
        (session.cost as number) ?? 0,
        (session.tokensInput as number) ?? 0,
        (session.tokensOutput as number) ?? 0,
        (session.tokensCacheRead as number) ?? 0,
        (session.model as string | null) ?? null,
        (session.timeCreated as number) ?? 0,
        (session.timeUpdated as number) ?? 0,
        (session.timeArchived as number | null) ?? null,
      ],
    );
  }

  let messageSeq = 0;
  for (const message of options.messages) {
    messageSeq++;
    db.run('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)', [
      message.id,
      message.sessionId,
      message.timeCreated,
      message.timeCreated,
      JSON.stringify(message.data),
    ]);
  }
  expect(messageSeq).toBe(options.messages.length);

  const sessionOfMessage = new Map(options.messages.map((m) => [m.id, m.sessionId]));
  let partSeq = 0;
  for (const part of options.parts) {
    partSeq++;
    db.run('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)', [
      `prt_${partSeq}`,
      part.messageId,
      sessionOfMessage.get(part.messageId) ?? '',
      part.timeCreated,
      part.timeCreated,
      JSON.stringify(part.data),
    ]);
  }

  db.close();
  return dbPath;
}

/**
 * Anchored to the clock rather than a literal epoch: `OpenCodeUsageService`
 * windows are relative to `Date.now()`, so a fixed timestamp would put the
 * fixture's turns outside the 24h window a day after it was written, and
 * outside the 7d window a week after — a suite that passes today and fails on
 * its own without a line changing.
 */
const NOW = Date.now();

/** One session with a two-turn conversation that used a tool. */
function standardFixture(): string {
  return buildDb({
    sessions: [
      {
        id: 'ses_main',
        directory: '/home/dev/project',
        title: 'Read note.txt contents',
        cost: 0.25,
        tokensInput: 9667,
        tokensOutput: 112,
        tokensCacheRead: 12800,
        model: JSON.stringify({ id: 'deepseek-v4-flash-free', providerID: 'opencode', variant: 'default' }),
        timeCreated: NOW - 20_000,
        timeUpdated: NOW,
      },
      // A subagent session: it belongs to a turn of ses_main, not to the user.
      {
        id: 'ses_child',
        parentId: 'ses_main',
        directory: '/home/dev/project',
        title: 'subagent',
        timeCreated: NOW - 15_000,
        timeUpdated: NOW - 14_000,
      },
      // An archived session must not appear either.
      {
        id: 'ses_archived',
        directory: '/home/dev/other',
        title: 'old work',
        timeCreated: NOW - 90_000,
        timeUpdated: NOW - 80_000,
        timeArchived: NOW - 70_000,
      },
    ],
    messages: [
      { id: 'msg_u1', sessionId: 'ses_main', timeCreated: NOW - 20_000, data: { role: 'user' } },
      {
        id: 'msg_a1',
        sessionId: 'ses_main',
        timeCreated: NOW - 19_000,
        data: {
          role: 'assistant',
          modelID: 'deepseek-v4-flash-free',
          providerID: 'opencode',
          cost: 0.1,
          tokens: { total: 11237, input: 9342, output: 103, reasoning: 0, cache: { write: 0, read: 1792 } },
        },
      },
      {
        id: 'msg_a2',
        sessionId: 'ses_main',
        timeCreated: NOW - 5_000,
        data: {
          role: 'assistant',
          modelID: 'deepseek-v4-flash-free',
          providerID: 'opencode',
          cost: 0.15,
          tokens: { total: 11342, input: 325, output: 9, reasoning: 0, cache: { write: 0, read: 11008 } },
        },
      },
    ],
    parts: [
      { messageId: 'msg_u1', data: { type: 'text', text: 'Read note.txt and tell me its contents.' }, timeCreated: NOW - 20_000 },
      { messageId: 'msg_a1', data: { type: 'step-start', snapshot: 'abc' }, timeCreated: NOW - 19_000 },
      { messageId: 'msg_a1', data: { type: 'reasoning', text: 'Read file note.txt.' }, timeCreated: NOW - 18_900 },
      {
        messageId: 'msg_a1',
        data: {
          type: 'tool',
          tool: 'read',
          callID: 'call_e747',
          state: {
            status: 'completed',
            input: { filePath: '/home/dev/project/note.txt' },
            output: '<content>\n1: probe file\n</content>',
            title: 'note.txt',
          },
        },
        timeCreated: NOW - 18_800,
      },
      { messageId: 'msg_a1', data: { type: 'step-finish', reason: 'tool-calls', cost: 0 }, timeCreated: NOW - 18_700 },
      { messageId: 'msg_a2', data: { type: 'text', text: 'Contents: `probe file`' }, timeCreated: NOW - 5_000 },
    ],
  });
}

describe('parseSessionModel', () => {
  test('joins provider and model id', () => {
    expect(parseSessionModel('{"id":"kimi-k3","providerID":"opencode","variant":"default"}')).toBe('opencode/kimi-k3');
  });

  test('falls back to the bare id, and tolerates junk', () => {
    expect(parseSessionModel('{"id":"solo"}')).toBe('solo');
    expect(parseSessionModel('not json')).toBeUndefined();
    expect(parseSessionModel(null)).toBeUndefined();
  });
});

describe('parseMessageTokens', () => {
  test('reads the nested cache block', () => {
    const tokens = parseMessageTokens(JSON.stringify({
      role: 'assistant',
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 3 } },
    }));
    expect(tokens).toEqual({ input: 10, output: 2, reasoning: 1, cacheRead: 5, cacheWrite: 3 });
  });

  test('a user message has no token block', () => {
    expect(parseMessageTokens(JSON.stringify({ role: 'user' }))).toBeUndefined();
  });
});

describe('contextTokensOf', () => {
  /** Cache reads are context that was carried in, so they belong in the total. */
  test('sums fresh input and cache reads', () => {
    expect(contextTokensOf({ input: 325, cacheRead: 11008 })).toBe(11333);
    expect(contextTokensOf({ output: 9 })).toBeUndefined();
    expect(contextTokensOf(undefined)).toBeUndefined();
  });
});

describe('OpenCodeSessionStore', () => {
  test('lists only sessions a user opened', async () => {
    const store = new OpenCodeSessionStore(standardFixture());
    const sessions = await store.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['ses_main']);
  });

  test('derives the first prompt from the first user text part', async () => {
    const store = new OpenCodeSessionStore(standardFixture());
    const [session] = await store.listSessions();
    expect(session?.firstPrompt).toBe('Read note.txt and tell me its contents.');
    expect(session?.cwd).toBe('/home/dev/project');
    expect(session?.model).toBe('opencode/deepseek-v4-flash-free');
  });

  /**
   * The first-prompt and recap queries pick a row per session with SQLite's
   * bare-column min/max rule rather than a window function. A session with one
   * text part each way would pass whatever that rule did, so this fixture gives
   * the query something to choose between - three assistant texts and two user
   * texts, inserted out of time order so row order cannot stand in for time.
   */
  test('picks the earliest user text and the latest assistant text', async () => {
    const dbPath = buildDb({
      sessions: [{ id: 'ses_many', directory: '/home/dev/many', title: 'many parts', timeCreated: 1, timeUpdated: 900 }],
      messages: [
        { id: 'msg_u1', sessionId: 'ses_many', timeCreated: 100, data: { role: 'user' } },
        { id: 'msg_a1', sessionId: 'ses_many', timeCreated: 200, data: { role: 'assistant', tokens: { input: 1, output: 1, cache: { read: 0 } } } },
        { id: 'msg_u2', sessionId: 'ses_many', timeCreated: 400, data: { role: 'user' } },
        { id: 'msg_a2', sessionId: 'ses_many', timeCreated: 500, data: { role: 'assistant', tokens: { input: 1, output: 1, cache: { read: 0 } } } },
      ],
      parts: [
        // Deliberately not in time order, and the reasoning part is later than
        // the last assistant text so a type-blind query would return it.
        { messageId: 'msg_a2', data: { type: 'text', text: 'LAST ASSISTANT' }, timeCreated: 500 },
        { messageId: 'msg_u1', data: { type: 'text', text: 'FIRST USER' }, timeCreated: 100 },
        { messageId: 'msg_a1', data: { type: 'text', text: 'EARLIER ASSISTANT' }, timeCreated: 200 },
        { messageId: 'msg_u2', data: { type: 'text', text: 'SECOND USER' }, timeCreated: 400 },
        { messageId: 'msg_a2', data: { type: 'reasoning', text: 'INTERNAL' }, timeCreated: 600 },
      ],
    });

    const store = new OpenCodeSessionStore(dbPath);
    const [session] = await store.listSessions();
    expect(session?.firstPrompt).toBe('FIRST USER');

    const thread = (await new OpenCodeService(store).getThreadsByIds(['ses_many'])).get('ses_many');
    expect(thread?.recap).toBe('LAST ASSISTANT');
  });

  /**
   * OpenCode writes a `"\n\n"` text part just before a tool call. Picking that
   * as the newest assistant text blanks the recap of a session that is mid-tool
   * - which is the moment its card is worth reading - so the query has to skip
   * it and take the real text one turn back. Note SQLite's bare `trim()` strips
   * spaces only, so a newline-only part survives the obvious predicate.
   */
  test('a blank filler text part does not blank the recap', async () => {
    const dbPath = buildDb({
      sessions: [{ id: 'ses_filler', directory: '/home/dev/filler', title: 'mid-tool', timeCreated: NOW - 1000, timeUpdated: NOW }],
      messages: [
        { id: 'msg_a1', sessionId: 'ses_filler', timeCreated: NOW - 900, data: { role: 'assistant', tokens: { input: 1, output: 1, cache: { read: 0 } } } },
        { id: 'msg_a2', sessionId: 'ses_filler', timeCreated: NOW - 100, data: { role: 'assistant', tokens: { input: 1, output: 1, cache: { read: 0 } } } },
      ],
      parts: [
        { messageId: 'msg_a1', data: { type: 'text', text: 'Done: refactored the parser and all tests pass.' }, timeCreated: NOW - 900 },
        { messageId: 'msg_a2', data: { type: 'text', text: '\n\n' }, timeCreated: NOW - 100 },
        { messageId: 'msg_a2', data: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running', input: {} } }, timeCreated: NOW - 90 },
      ],
    });
    const store = new OpenCodeSessionStore(dbPath);
    const thread = (await new OpenCodeService(store).getThreadsByIds(['ses_filler'])).get('ses_filler');
    expect(thread?.recap).toBe('Done: refactored the parser and all tests pass.');
  });

  test('a long recap is capped rather than flooding the card', async () => {
    const long = 'x'.repeat(700);
    const dbPath = buildDb({
      sessions: [{ id: 'ses_long', directory: '/home/dev/long', title: 'long', timeCreated: 1, timeUpdated: 2 }],
      messages: [{ id: 'msg_a', sessionId: 'ses_long', timeCreated: 2, data: { role: 'assistant', tokens: { input: 1, output: 1, cache: { read: 0 } } } }],
      parts: [{ messageId: 'msg_a', data: { type: 'text', text: long }, timeCreated: 2 }],
    });
    const store = new OpenCodeSessionStore(dbPath);
    const thread = (await new OpenCodeService(store).getThreadsByIds(['ses_long'])).get('ses_long');
    expect(thread?.recap).toHaveLength(501);
    expect(thread?.recap?.endsWith('…')).toBe(true);
  });

  test('a missing database is empty rather than an error', async () => {
    const store = new OpenCodeSessionStore('/nonexistent/opencode.db');
    expect(await store.listSessions()).toEqual([]);
    expect(store.getSessionParts('ses_main')).toEqual([]);
    expect(store.listAssistantTurns()).toEqual([]);
  });
});

describe('OpenCodeService', () => {
  test('resolves threads by native session id', async () => {
    const service = new OpenCodeService(new OpenCodeSessionStore(standardFixture()));
    const threads = await service.getThreadsByIds(['ses_main', 'ses_unknown']);

    expect([...threads.keys()]).toEqual(['ses_main']);
    const thread = threads.get('ses_main');
    expect(thread?.title).toBe('Read note.txt contents');
    // Recap is the last assistant text, not the reasoning part before it.
    expect(thread?.recap).toBe('Contents: `probe file`');
    // Context comes from the latest turn; the totals come from the session row.
    expect(thread?.tokenUsage?.contextTokens).toBe(11333);
    expect(thread?.tokenUsage?.totalInputTokens).toBe(9667);
    expect(thread?.tokenUsage?.totalOutputTokens).toBe(112);
    expect(thread?.tokenUsage?.model).toBe('opencode/deepseek-v4-flash-free');
    // OpenCode records no context window locally, so no percentage is invented.
    expect(thread?.tokenUsage?.contextMaxTokens).toBeUndefined();
    expect(thread?.tokenUsage?.contextPercent).toBeUndefined();
  });

  test('no ids means no query', async () => {
    const service = new OpenCodeService(new OpenCodeSessionStore(standardFixture()));
    expect((await service.getThreadsByIds([])).size).toBe(0);
  });
});

describe('parseOpenCodeMessages', () => {
  test('splits a single tool row back into a call and a result', async () => {
    const store = new OpenCodeSessionStore(standardFixture());
    const messages = parseOpenCodeMessages(store.getSessionParts('ses_main'));

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[0]?.content).toBe('Read note.txt and tell me its contents.');

    // The call sits on the assistant turn...
    const call = messages[1]?.toolUse?.[0];
    expect(call).toEqual({
      id: 'call_e747',
      name: 'read',
      input: { filePath: '/home/dev/project/note.txt' },
    });
    // ...and its output on the user turn after it, paired by toolUseId, which is
    // the shape ConversationViewer collapses back into one card.
    const result = messages[2]?.toolResult?.[0];
    expect(result?.toolUseId).toBe('call_e747');
    expect(result?.toolName).toBe('read');
    expect(result?.output).toContain('probe file');

    expect(messages[3]?.content).toBe('Contents: `probe file`');
  });

  test('reasoning, step-start and step-finish parts are dropped', () => {
    const messages = parseOpenCodeMessages([
      {
        role: 'assistant',
        parts: [
          JSON.stringify({ type: 'step-start', snapshot: 'abc' }),
          JSON.stringify({ type: 'reasoning', text: 'thinking out loud' }),
          JSON.stringify({ type: 'text', text: 'the answer' }),
          JSON.stringify({ type: 'step-finish', reason: 'stop', cost: 0 }),
        ],
      },
    ]);
    expect(messages).toEqual([{ role: 'assistant', content: 'the answer' }]);
  });

  test('a tool call still in flight produces no result turn', () => {
    const messages = parseOpenCodeMessages([
      {
        role: 'assistant',
        parts: [JSON.stringify({
          type: 'tool',
          tool: 'bash',
          callID: 'call_pending',
          state: { status: 'running', input: { command: 'ls' } },
        })],
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.toolUse?.[0]?.name).toBe('bash');
    expect(messages[0]?.toolResult).toBeUndefined();
  });

  /**
   * A rejected call carries `state.error` and no `output`. Read as "no output"
   * it would render exactly like a call still running, and the viewer's red,
   * auto-expanded error treatment would never fire.
   */
  test('a rejected tool call is a result marked as an error', () => {
    const messages = parseOpenCodeMessages([
      {
        role: 'assistant',
        parts: [JSON.stringify({
          type: 'tool',
          tool: 'read',
          callID: 'call_denied',
          state: {
            status: 'error',
            input: { filePath: '/etc/shadow' },
            error: 'The user rejected permission to use this specific tool call.',
          },
        })],
      },
    ]);
    expect(messages).toHaveLength(2);
    const result = messages[1]?.toolResult?.[0];
    expect(result?.isError).toBe(true);
    expect(result?.output).toBe('The user rejected permission to use this specific tool call.');
    expect(result?.toolUseId).toBe('call_denied');
  });

  test('an error with no message still says something', () => {
    const messages = parseOpenCodeMessages([
      {
        role: 'assistant',
        parts: [JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c', state: { status: 'error' } })],
      },
    ]);
    expect(messages[1]?.toolResult?.[0]).toEqual({
      toolUseId: 'c',
      toolName: 'bash',
      output: 'Tool call failed',
      isError: true,
    });
  });

  test('a malformed part row does not lose the rest of the turn', () => {
    const messages = parseOpenCodeMessages([
      { role: 'assistant', parts: ['{ not json', JSON.stringify({ type: 'text', text: 'still here' })] },
    ]);
    expect(messages).toEqual([{ role: 'assistant', content: 'still here' }]);
  });
});

describe('OpenCodeHistoryService', () => {
  test('groups projects by session.directory', async () => {
    const service = new OpenCodeHistoryService(new OpenCodeSessionStore(standardFixture()));
    const projects = await service.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectPath).toBe('/home/dev/project');
    expect(projects[0]?.sessionCount).toBe(1);
  });

  test('search matches the title and the first prompt', async () => {
    const service = new OpenCodeHistoryService(new OpenCodeSessionStore(standardFixture()));
    expect(await service.searchSessions('note.txt')).toHaveLength(1);
    expect(await service.searchSessions('nothing like this')).toHaveLength(0);
    expect(await service.searchSessions('   ')).toHaveLength(0);
  });

  test('history sessions are tagged with the agent', async () => {
    const service = new OpenCodeHistoryService(new OpenCodeSessionStore(standardFixture()));
    const [session] = await service.getRecentSessions();
    expect(session?.agent).toBe('opencode');
    expect(session?.summary).toBe('Read note.txt contents');
  });
});

describe('OpenCodeUsageService', () => {
  test('aggregates turns, tokens and OpenCode\'s own cost', async () => {
    const service = new OpenCodeUsageService(new OpenCodeSessionStore(standardFixture()));
    const summary = await service.getUsageSummary();

    expect(summary?.last24h.turns).toBe(2);
    // (9342 + 1792 + 103) + (325 + 11008 + 9)
    expect(summary?.last24h.totalTokens).toBe(22579);
    expect(summary?.last24h.cacheReadTokens).toBe(12800);
    expect(summary?.sessions7d).toBe(1);
    // The cost is OpenCode's recorded figure, summed - not a price-list estimate.
    expect(summary?.last24h.costUsd).toBeCloseTo(0.25, 10);
    expect(summary?.models).toEqual([
      { model: 'opencode/deepseek-v4-flash-free', totalTokens: 22579, costUsd: 0.25 },
    ]);
  });

  test('no turns at all reports nothing rather than a zeroed summary', async () => {
    const dbPath = buildDb({
      sessions: [{ id: 'ses_empty', directory: '/tmp/x', title: 'empty', timeCreated: NOW, timeUpdated: NOW }],
      messages: [],
      parts: [],
    });
    expect(await new OpenCodeUsageService(new OpenCodeSessionStore(dbPath)).getUsageSummary()).toBeNull();
  });
});
