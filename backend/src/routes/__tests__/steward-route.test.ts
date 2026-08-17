import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { IDENTITY, PASSWORD_ENV, TMP_PATHS } from '../../../../shared/identity';
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

  // The Send row on a multi-select exists because a tap there is a toggle, so
  // "none of these" is a decision the wearer can reach and had no way to send.
  test('accepts none of them on a multi-answer question', async () => {
    const askId = await ask(['a', 'b'], 'multi');
    const res = await post('/api/steward/thread/reply', {
      askId,
      answer: { kind: 'choice', indices: [] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { text: string } };
    // Reads back as a sentence: an empty string here is a reply that says
    // nothing, which is exactly what an unanswered question looks like.
    expect(body.item.text).toBe('none of them');
  });

  test('rejects an empty answer to a single-answer question', async () => {
    const askId = await ask(['a', 'b']);
    const res = await post('/api/steward/thread/reply', {
      askId,
      answer: { kind: 'choice', indices: [] },
    });
    expect(res.status).toBe(400);
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

  test('an entry about a session lands on that session too', async () => {
    const res = await post('/api/steward/thread', {
      kind: 'notify',
      text: 'レビューが7件返っています',
      sessionId: 'w5Q',
    });
    const { item } = (await res.json()) as { item: { id: string; sessionId?: string } };
    expect(item.sessionId).toBe('w5Q');

    const turns = (await (await app.request('/api/steward/sessions/w5Q/turns')).json()) as {
      turns: { id: string; text: string }[];
    };
    // Same id both places: the mirror is an upsert, not a second entry.
    expect(turns.turns).toHaveLength(1);
    expect(turns.turns[0]?.id).toBe(item.id);
  });

  test('an attached image travels with the reply', async () => {
    // Through TMP_PATHS: a literal here would be a second copy of the upload
    // directory's name, and stop matching the day the identity changes.
    const shot = join(TMP_PATHS.imagesDir, 'a.jpg');
    const res = await post('/api/steward/thread/reply', {
      text: '狭いです',
      images: [shot],
      sessionId: 'w5Q',
    });
    const { item } = (await res.json()) as { item: { images?: string[] } };
    expect(item.images).toEqual([shot]);

    const turns = (await (await app.request('/api/steward/sessions/w5Q/turns')).json()) as {
      turns: { images?: string[] }[];
    };
    expect(turns.turns[0]?.images).toEqual([shot]);
  });

  test('a reply written from a session lands there as the person said it', async () => {
    await post('/api/steward/thread/reply', { text: 'あとどのくらい', sessionId: 'w5Q' });

    const turns = (await (await app.request('/api/steward/sessions/w5Q/turns')).json()) as {
      turns: { role: string; text: string }[];
    };
    expect(turns.turns).toEqual([
      expect.objectContaining({ role: 'user', text: 'あとどのくらい' }),
    ]);
  });

  test('the same line twice in a row is written once', async () => {
    const say = () =>
      post('/api/steward/thread', {
        kind: 'notify',
        text: '画像パスを渡しました',
        sessionId: 'w5Q',
      });
    await say();
    await say();

    const thread = (await (await app.request('/api/steward')).json()) as {
      thread: { text: string }[];
    };
    expect(thread.thread.filter((i) => i.text === '画像パスを渡しました')).toHaveLength(1);

    const turns = (await (await app.request('/api/steward/sessions/w5Q/turns')).json()) as {
      turns: unknown[];
    };
    expect(turns.turns).toHaveLength(1);
  });

  test('the same line again after something else is a report, not a repeat', async () => {
    await post('/api/steward/thread', { kind: 'notify', text: 'まだ動いています', sessionId: 'w5Q' });
    await post('/api/steward/thread', { kind: 'notify', text: '一件終わりました', sessionId: 'w5Q' });
    await post('/api/steward/thread', { kind: 'notify', text: 'まだ動いています', sessionId: 'w5Q' });

    const turns = (await (await app.request('/api/steward/sessions/w5Q/turns')).json()) as {
      turns: { text: string }[];
    };
    expect(turns.turns.map((t) => t.text)).toEqual([
      'まだ動いています',
      '一件終わりました',
      'まだ動いています',
    ]);
  });

  test('an entry naming no session touches no session history', async () => {
    await post('/api/steward/thread', { kind: 'notify', text: '3件が止まっています' });
    await post('/api/steward/thread/reply', { text: 'どれ' });

    const turns = (await (await app.request('/api/steward/sessions/w5Q/turns')).json()) as {
      turns: unknown[];
    };
    expect(turns.turns).toEqual([]);
  });

  test('a question and its answer join the session once it is answered', async () => {
    const asked = await post('/api/steward/thread', {
      kind: 'ask',
      text: '巻き戻しますか',
      choices: ['はい', 'いいえ'],
      sessionId: 'w5Q',
    });
    const { askId } = (await asked.json()) as { askId: string };

    await post('/api/steward/thread/reply', { askId, answer: { kind: 'choice', indices: [0] } });

    // Answered from that session's own screen, the decision has to be left
    // behind - and the answer alone would be a word with no question.
    const turns = (await (await app.request('/api/steward/sessions/w5Q/turns')).json()) as {
      turns: { role: string; text: string }[];
    };
    expect(turns.turns.map((t) => t.text)).toEqual(['巻き戻しますか', 'はい']);
  });

  test('a question still waiting stays out of the session history', async () => {
    await post('/api/steward/thread', {
      kind: 'ask',
      text: 'まだ答えていない質問',
      choices: ['はい'],
      sessionId: 'w5Q',
    });

    const turns = (await (await app.request('/api/steward/sessions/w5Q/turns')).json()) as {
      turns: unknown[];
    };
    expect(turns.turns).toEqual([]);
  });

  // Direct-talk mode on the glasses reaches the agent without the steward. The
  // steward still has to see it, or the pane's next move is a change it cannot
  // account for.
  test('speaking straight to a pane is recorded against that session', async () => {
    const res = await post('/api/steward/sessions/w5Q/spoke', { text: 'そのまま進めて' });
    expect(res.status).toBe(200);

    const turns = (await (await app.request('/api/steward/sessions/w5Q/turns')).json()) as {
      turns: { role: string; text: string }[];
    };
    expect(turns.turns).toEqual([
      expect.objectContaining({ role: 'user', text: 'そのまま進めて' }),
    ]);
  });

  test('an empty utterance is not a record of anything', async () => {
    expect((await post('/api/steward/sessions/w5Q/spoke', { text: '' })).status).toBe(400);
    expect((await post('/api/steward/sessions/w5Q/spoke', {})).status).toBe(400);
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
