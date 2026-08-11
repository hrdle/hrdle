import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { CodexService } from '../../src/services/codex';

const TEST_DIR = join(tmpdir(), `hrdle-codex-service-${Date.now()}`);
const DB_PATH = join(TEST_DIR, 'state_5.sqlite');

function createThreadsTable(db: Database): void {
  db.run(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      first_user_message TEXT,
      tokens_used INTEGER,
      rollout_path TEXT,
      git_branch TEXT,
      cwd TEXT NOT NULL,
      created_at INTEGER,
      updated_at INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      archived INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function insertThread(db: Database, row: {
  id: string;
  cwd: string;
  title: string;
  firstUserMessage: string;
  tokensUsed: number;
  gitBranch?: string;
  rolloutPath?: string;
  updatedAtMs: number;
  archived?: number;
}): void {
  db.run(
    `INSERT INTO threads (
      id,
      cwd,
      title,
      first_user_message,
      tokens_used,
      rollout_path,
      git_branch,
      created_at,
      updated_at,
      created_at_ms,
      updated_at_ms,
      archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.cwd,
      row.title,
      row.firstUserMessage,
      row.tokensUsed,
      row.rolloutPath ?? null,
      row.gitBranch ?? null,
      Math.floor(row.updatedAtMs / 1000),
      Math.floor(row.updatedAtMs / 1000),
      row.updatedAtMs,
      row.updatedAtMs,
      row.archived ?? 0,
    ],
  );
}

describe('CodexService', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test('returns an empty map when the state database does not exist', async () => {
    const service = new CodexService(join(TEST_DIR, 'missing.sqlite'));

    const threads = await service.getThreadsByIds(['missing']);

    expect(threads.size).toBe(0);
  });

  test('returns exact unarchived threads by native session id', async () => {
    const db = new Database(DB_PATH);
    createThreadsTable(db);
    insertThread(db, {
      id: 'older',
      cwd: '/repo',
      title: 'Older title',
      firstUserMessage: 'older prompt',
      tokensUsed: 100,
      updatedAtMs: 1000,
    });
    insertThread(db, {
      id: 'newer',
      cwd: '/repo',
      title: 'Newer title',
      firstUserMessage: 'newer prompt',
      tokensUsed: 250,
      gitBranch: 'feat/codex',
      updatedAtMs: 2000,
    });
    insertThread(db, {
      id: 'other',
      cwd: '/other',
      title: 'Other title',
      firstUserMessage: 'other prompt',
      tokensUsed: 300,
      updatedAtMs: 1500,
    });
    db.close();

    const service = new CodexService(DB_PATH);
    const threads = await service.getThreadsByIds(['older', 'newer', 'other', 'missing']);

    expect(threads.get('older')?.sessionId).toBe('older');
    expect(threads.get('newer')?.title).toBe('Newer title');
    expect(threads.get('newer')?.firstPrompt).toBe('newer prompt');
    expect(threads.get('newer')?.tokensUsed).toBe(250);
    expect(threads.get('newer')?.gitBranch).toBe('feat/codex');
    expect(threads.get('other')?.sessionId).toBe('other');
    expect(threads.has('missing')).toBe(false);
  });

  test('ignores archived threads', async () => {
    const db = new Database(DB_PATH);
    createThreadsTable(db);
    insertThread(db, {
      id: 'archived',
      cwd: '/repo',
      title: 'Archived',
      firstUserMessage: 'archived prompt',
      tokensUsed: 1000,
      updatedAtMs: 3000,
      archived: 1,
    });
    db.close();

    const service = new CodexService(DB_PATH);
    const threads = await service.getThreadsByIds(['archived']);

    expect(threads.size).toBe(0);
  });

  test('reads latest token_count event from rollout jsonl', async () => {
    const rolloutPath = join(TEST_DIR, 'rollout.jsonl');
    await writeFile(rolloutPath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 50,
              output_tokens: 20,
              total_tokens: 120,
            },
            last_token_usage: {
              input_tokens: 40,
              total_tokens: 45,
            },
            model_context_window: 200,
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 350,
              cached_input_tokens: 75,
              output_tokens: 30,
              total_tokens: 380,
            },
            last_token_usage: {
              input_tokens: 125,
              total_tokens: 130,
            },
            model_context_window: 250,
          },
        },
      }),
      '',
    ].join('\n'));

    const db = new Database(DB_PATH);
    createThreadsTable(db);
    insertThread(db, {
      id: 'with-rollout',
      cwd: '/repo',
      title: 'With rollout',
      firstUserMessage: 'prompt',
      tokensUsed: 999,
      rolloutPath,
      updatedAtMs: 1000,
    });
    db.close();

    const service = new CodexService(DB_PATH);
    const thread = (await service.getThreadsByIds(['with-rollout'])).get('with-rollout');

    expect(thread?.tokenUsage?.contextTokens).toBe(125);
    expect(thread?.tokenUsage?.contextMaxTokens).toBe(250);
    expect(thread?.tokenUsage?.contextPercent).toBe(50);
    expect(thread?.tokenUsage?.totalInputTokens).toBe(350);
    expect(thread?.tokenUsage?.totalCacheReadTokens).toBe(75);
    expect(thread?.tokenUsage?.totalOutputTokens).toBe(30);
    expect(thread?.tokenUsage?.totalTokens).toBe(380);
  });
});
