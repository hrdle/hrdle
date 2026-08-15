import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../../shared/identity';
import type { StewardTurn } from '../../../../shared/types';
import {
  answerAsk,
  appendSessionTurns,
  appendThreadItem,
  getLines,
  getSessionTurns,
  getThread,
  pruneToSessions,
  removeSession,
  setLine,
} from '../steward-store';

const DATA_DIR_ENV = IDENTITY.dataDirEnv;

let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(async () => {
  savedDataDir = process.env[DATA_DIR_ENV];
  dataDir = await mkdtemp(join(tmpdir(), 'steward-store-'));
  process.env[DATA_DIR_ENV] = dataDir;
});

afterEach(async () => {
  if (savedDataDir === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = savedDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

function turn(id: string, text: string): StewardTurn {
  return { id, at: Date.now(), role: 'agent', text };
}

describe('steward thread', () => {
  it('reads back empty before anything is written', async () => {
    expect(await getThread()).toEqual([]);
  });

  it('stamps an id and a time', async () => {
    const item = await appendThreadItem({ kind: 'notify', role: 'steward', text: 'hello' });
    expect(item.id).toBeTruthy();
    expect(item.at).toBeGreaterThan(0);
    expect(await getThread()).toHaveLength(1);
  });

  it('records an answer against its ask', async () => {
    const item = await appendThreadItem({
      kind: 'ask',
      role: 'steward',
      text: 'deploy?',
      ask: { id: 'ask-1', mode: 'single', choices: ['yes', 'no'] },
    });
    expect(item.kind).toBe('ask');

    const updated = await answerAsk('ask-1', { kind: 'choice', indices: [0] });
    expect(updated?.kind === 'ask' && updated.ask.answer).toEqual({ kind: 'choice', indices: [0] });
    expect(updated?.kind === 'ask' && updated.ask.answeredAt).toBeGreaterThan(0);
  });

  // Distinct from an absent answer: without it, an abandoned question stays
  // pending on every wake-up.
  it('accepts dismissal as an answer', async () => {
    await appendThreadItem({
      kind: 'ask',
      role: 'steward',
      text: 'deploy?',
      ask: { id: 'ask-2', mode: 'single', choices: [] },
    });
    const updated = await answerAsk('ask-2', { kind: 'dismissed' });
    expect(updated?.kind === 'ask' && updated.ask.answer).toEqual({ kind: 'dismissed' });
  });

  it('reports an unknown ask rather than inventing one', async () => {
    expect(await answerAsk('nope', { kind: 'dismissed' })).toBeNull();
  });

  it('survives a store written by an older or corrupt run', async () => {
    await Bun.write(join(dataDir, 'steward-thread.json'), 'not json');
    expect(await getThread()).toEqual([]);
  });
});

describe('overview lines', () => {
  it('keeps one line per session, replacing rather than appending', async () => {
    await setLine('w1', 'first');
    await setLine('w1', 'second');
    await setLine('w2', 'other');

    const lines = await getLines();
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.sessionId === 'w1')?.text).toBe('second');
  });
});

describe('session turns', () => {
  it('appends new turns and rewrites ones already there', async () => {
    await appendSessionTurns('w1', [turn('t1', 'one'), turn('t2', 'two')]);
    await appendSessionTurns('w1', [turn('t2', 'two, amended')]);

    const turns = await getSessionTurns('w1');
    expect(turns.map((t) => t.text)).toEqual(['one', 'two, amended']);
  });

  it('keeps sessions apart', async () => {
    await appendSessionTurns('w1', [turn('t1', 'w1 turn')]);
    await appendSessionTurns('w2', [turn('t1', 'w2 turn')]);
    expect((await getSessionTurns('w1'))[0].text).toBe('w1 turn');
    expect((await getSessionTurns('w2'))[0].text).toBe('w2 turn');
  });

  it('drops the oldest turns past the per-session cap', async () => {
    const many = Array.from({ length: 70 }, (_, i) => turn(`t${i}`, `turn ${i}`));
    const stored = await appendSessionTurns('w1', many);
    expect(stored).toHaveLength(60);
    expect(stored[0].id).toBe('t10');
  });

  it('evicts the least recently written session past the session cap', async () => {
    for (let i = 0; i < 32; i++) {
      await appendSessionTurns(`w${i}`, [turn('t1', 'x')]);
    }
    expect(await getSessionTurns('w0')).toEqual([]);
    expect(await getSessionTurns('w31')).toHaveLength(1);
  });

  // Recency is stored, not inferred from key order: an integer-like key is
  // ordered ahead of every other key whatever the write order, so a numeric id
  // would always be evicted first however recently it was written.
  it('evicts by when it was written, even for a numeric session id', async () => {
    for (let i = 0; i < 30; i++) {
      await appendSessionTurns(`w${i}`, [turn('t1', 'x')]);
    }
    // Written last, so it is the one to keep. Under key order it would be the
    // one to go: an integer-like key sorts ahead of every other key.
    await appendSessionTurns('9', [turn('t1', 'newest')]);

    expect(await getSessionTurns('9')).toHaveLength(1);
    expect(await getSessionTurns('w0')).toEqual([]);
  });
});

describe('cleanup', () => {
  it('removes a gone workspace from both stores', async () => {
    await setLine('w1', 'line');
    await appendSessionTurns('w1', [turn('t1', 'x')]);

    expect(await removeSession('w1')).toBe(true);
    expect(await getLines()).toEqual([]);
    expect(await getSessionTurns('w1')).toEqual([]);
  });

  // A workspace can also vanish while the server is down, and nothing replays
  // that afterwards - so the live set is what decides, not a delete event.
  it('prunes everything not in the live set', async () => {
    await setLine('w1', 'live');
    await setLine('w2', 'gone');
    await appendSessionTurns('w3', [turn('t1', 'gone too')]);

    const removed = await pruneToSessions(['w1']);
    expect(removed.sort()).toEqual(['w2', 'w3']);
    expect((await getLines()).map((l) => l.sessionId)).toEqual(['w1']);
  });

  it('leaves the thread alone - it belongs to no session', async () => {
    await appendThreadItem({ kind: 'notify', role: 'steward', text: 'hello' });
    await pruneToSessions([]);
    expect(await getThread()).toHaveLength(1);
  });
});
