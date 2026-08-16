import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { IDENTITY, PASSWORD_ENV } from '../../../../shared/identity';
import { AuthService } from '../../services/auth';
import { conditionalAuthMiddleware, getJwtSecret, initJwtSecret } from '../../middleware/auth';
import { STEWARD_ENV } from '../../services/steward-config';
import { steward } from '../steward';

const DATA_DIR_ENV = IDENTITY.dataDirEnv;

let dataDir: string;
let savedDataDir: string | undefined;
let savedGate: string | undefined;

/** Mirrors index.ts, middleware included: mounting the router bare would leave
 *  the self-signed-token invariant untested, and a reordering there would break
 *  it in silence. */
const app = new Hono()
  .use('/api/steward', conditionalAuthMiddleware)
  .use('/api/steward/*', conditionalAuthMiddleware)
  .route('/api/steward', steward);

function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  savedDataDir = process.env[DATA_DIR_ENV];
  savedGate = process.env[STEWARD_ENV];
  dataDir = await mkdtemp(join(tmpdir(), 'steward-route-'));
  process.env[DATA_DIR_ENV] = dataDir;
  process.env[STEWARD_ENV] = '1';
});

afterEach(async () => {
  if (savedDataDir === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = savedDataDir;
  if (savedGate === undefined) delete process.env[STEWARD_ENV];
  else process.env[STEWARD_ENV] = savedGate;
  await rm(dataDir, { recursive: true, force: true });
});

describe('the gate', () => {
  test('404s every route when off', async () => {
    delete process.env[STEWARD_ENV];
    expect((await app.request('/api/steward')).status).toBe(404);
    expect((await post('/api/steward/thread', { kind: 'notify', text: 'x' })).status).toBe(404);
    expect((await app.request('/api/steward/screen')).status).toBe(404);
  });

  // The one route that answers either way: the CLI asks it to tell "switched
  // off" apart from "server too old", which a 404 cannot say.
  test('still answers /enabled when off', async () => {
    delete process.env[STEWARD_ENV];
    const res = await app.request('/api/steward/enabled');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  test('reports the models when on', async () => {
    const body = (await (await app.request('/api/steward/enabled')).json()) as {
      enabled: boolean;
      settings: { observerModel: string; workerModel: string };
    };
    expect(body.enabled).toBe(true);
    expect(body.settings.observerModel).toBe('sonnet');
  });
});

describe('the thread', () => {
  test('an ask carries the item id, so the two cannot disagree', async () => {
    const body = (await (
      await post('/api/steward/thread', { kind: 'ask', text: 'deploy?', choices: ['yes', 'no'] })
    ).json()) as { item: { id: string }; askId: string };
    expect(body.askId).toBe(body.item.id);
  });

  test('a reply records the answer and reads back as its own turn', async () => {
    const asked = (await (
      await post('/api/steward/thread', { kind: 'ask', text: 'deploy?', choices: ['yes', 'no'] })
    ).json()) as { askId: string };

    const replied = (await (
      await post('/api/steward/thread/reply', {
        askId: asked.askId,
        answer: { kind: 'choice', indices: [1] },
      })
    ).json()) as { item: { text: string; role: string } };

    // Named by its label rather than its index: the thread has to read back as
    // a conversation, not as a form's stored value.
    expect(replied.item.text).toBe('no');
    expect(replied.item.role).toBe('user');
  });

  test('rejects an answer to a question that does not exist', async () => {
    const res = await post('/api/steward/thread/reply', { askId: 'nope', answer: { kind: 'dismissed' } });
    expect(res.status).toBe(404);
  });

  test('rejects an askId with no answer, and an answer with neither', async () => {
    expect((await post('/api/steward/thread/reply', { askId: 'x' })).status).toBe(400);
    expect((await post('/api/steward/thread/reply', {})).status).toBe(400);
  });

  test('rejects an unknown kind', async () => {
    expect((await post('/api/steward/thread', { kind: 'shout', text: 'x' })).status).toBe(400);
  });
});

describe('answers are checked against the question', () => {
  async function ask(choices: string[], mode = 'single') {
    const body = (await (
      await post('/api/steward/thread', { kind: 'ask', text: 'pick', choices, mode })
    ).json()) as { askId: string };
    return body.askId;
  }

  // The steward reads ask.answer as the record of what was decided, so an index
  // nobody was offered would become a decision nobody made.
  test('rejects a choice that was never offered', async () => {
    const askId = await ask(['yes', 'no']);
    const res = await post('/api/steward/thread/reply', {
      askId,
      answer: { kind: 'choice', indices: [5] },
    });
    expect(res.status).toBe(400);
  });

  test('rejects several answers to a single-answer question', async () => {
    const askId = await ask(['a', 'b', 'c']);
    const res = await post('/api/steward/thread/reply', {
      askId,
      answer: { kind: 'choice', indices: [0, 1] },
    });
    expect(res.status).toBe(400);
  });

  test('accepts several on a multi-answer question', async () => {
    const askId = await ask(['a', 'b', 'c'], 'multi');
    const res = await post('/api/steward/thread/reply', {
      askId,
      answer: { kind: 'choice', indices: [0, 2] },
    });
    expect(res.status).toBe(200);
  });

  test('rejects a choice against a free-text question', async () => {
    const askId = await ask([], 'freeText');
    const res = await post('/api/steward/thread/reply', {
      askId,
      answer: { kind: 'choice', indices: [0] },
    });
    expect(res.status).toBe(400);
  });

  // Accepting it would record the reply and drop the choice it carried.
  test('rejects an answer with no question', async () => {
    const res = await post('/api/steward/thread/reply', { answer: { kind: 'dismissed' } });
    expect(res.status).toBe(400);
  });
});

describe('authentication', () => {
  // The CLI signs its own token from <dataDir>/jwt-secret. Nothing else proves
  // the server actually accepts one.
  test('a self-signed token is accepted, and no token is not', async () => {
    process.env[PASSWORD_ENV] = 'a-password';
    try {
      // Asked for rather than read from the file the CLI reads: the secret is
      // resolved once per process, so in a full run another test file may have
      // initialised it first and the file here would be the wrong one.
      await initJwtSecret();
      const token = await new AuthService(dataDir, getJwtSecret()).generateTokenForUser('steward');

      const withToken = await app.request('/api/steward', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(withToken.status).toBe(200);

      expect((await app.request('/api/steward')).status).toBe(401);
      expect(
        (await app.request('/api/steward', { headers: { Authorization: 'Bearer nonsense' } })).status,
      ).toBe(401);
    } finally {
      delete process.env[PASSWORD_ENV];
    }
  });
});

describe('session writes', () => {
  test('rejects a session id that is not one', async () => {
    const res = await app.request('/api/steward/sessions/..%2Fetc/line', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  test('a text past one page keeps its overflow, in detail', async () => {
    const long = 'あ'.repeat(400);
    const res = await post('/api/steward/thread', { kind: 'notify', text: long });
    const body = (await res.json()) as { item: { text: string; detail?: string }; fitted?: string };
    expect(body.item.text.length).toBeLessThan(400);
    expect(`${body.item.text}${body.item.detail}`.replace('…', '')).toBe(long);
    // Said out loud: the writer has to know its split was overridden.
    expect(body.fitted).toBeTruthy();
  });

  test('turns are fitted the same way', async () => {
    const long = 'あ'.repeat(400);
    const res = await post('/api/steward/sessions/w5Q/turns', {
      turns: [{ id: 't1', role: 'agent', text: long }],
    });
    const body = (await res.json()) as { turns: { text: string; detail?: string }[]; fitted?: string };
    expect(body.turns[0]?.text.length).toBeLessThan(400);
    expect(body.turns[0]?.detail).toBeTruthy();
    expect(body.fitted).toBeTruthy();
  });
});
