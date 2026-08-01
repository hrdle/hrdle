import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { conditionalAuthMiddleware } from '../../middleware/auth';
import { resetGlassesRelayForTest } from '../../services/glasses-relay';
import { glassesRelay } from '../glasses-relay';
import { PASSWORD_ENV } from '../../../../shared/identity';

/**
 * Mirrors index.ts: `/api/glasses/relay*` is reachable WITHOUT a token even
 * when password auth is on (local-trust POSTs from `<bin> glasses`), while
 * everything else under `/api/glasses/*` stays behind conditionalAuth.
 */
function makeApp(): Hono {
  const app = new Hono();
  app.use('/api/glasses/*', (c, next) => {
    if (c.req.path.startsWith('/api/glasses/relay')) return next();
    return conditionalAuthMiddleware(c, next);
  });
  app.route('/api/glasses/relay', glassesRelay);
  app.post('/api/glasses/stt', (c) => c.json({ text: '' })); // stand-in for the protected route
  return app;
}

const app = makeApp();

function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = { sessionId: 'sess-1', kind: 'info', text: 'hello' };

beforeEach(() => {
  resetGlassesRelayForTest();
});

describe('POST /api/glasses/relay — validation defense', () => {
  test('accepts a valid body and returns the clamped item', async () => {
    const res = await post('/api/glasses/relay', {
      ...VALID,
      choices: ['a', 'b'],
      paneId: '%2',
      text: `  multi\n  line   text `,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; item: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.item.sessionId).toBe('sess-1');
    expect(json.item.text).toBe('multi line text');
    expect(json.item.kind).toBe('info');
    expect(json.item.source).toBe('agent');
    expect(json.item.paneId).toBe('%2');
    expect(json.item.choices).toEqual(['a', 'b']);
  });

  test('rejects a sessionId outside the safe alphabet', async () => {
    for (const sessionId of ['bad/id', 'bad id', '../x', 'a'.repeat(129), 42]) {
      const res = await post('/api/glasses/relay', { ...VALID, sessionId });
      expect(res.status).toBe(400);
    }
  });

  test('rejects a missing/invalid kind', async () => {
    expect((await post('/api/glasses/relay', { sessionId: 's', text: 'x' })).status).toBe(400);
    expect(
      (await post('/api/glasses/relay', { sessionId: 's', kind: 'progress', text: 'x' })).status,
    ).toBe(400);
  });

  test('rejects empty or oversized text', async () => {
    expect((await post('/api/glasses/relay', { ...VALID, text: '   ' })).status).toBe(400);
    expect((await post('/api/glasses/relay', { ...VALID, text: 'x'.repeat(4001) })).status).toBe(
      400,
    );
  });

  test('rejects a malformed paneId', async () => {
    expect((await post('/api/glasses/relay', { ...VALID, paneId: '2' })).status).toBe(400);
    expect((await post('/api/glasses/relay', { ...VALID, paneId: '%' })).status).toBe(400);
    expect((await post('/api/glasses/relay', { ...VALID, paneId: '%1:p2' })).status).toBe(400);
  });

  test('accepts a base36 paneId', async () => {
    // herdr numbers panes in base36, so a busy workspace's panes are `%A`,
    // `%B`, ... — rejecting those left the tenth pane onwards unaddressable.
    expect((await post('/api/glasses/relay', { ...VALID, paneId: '%A' })).status).toBe(200);
  });

  test('rejects too many or empty choices', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `c${i}`);
    expect((await post('/api/glasses/relay', { ...VALID, choices: many })).status).toBe(400);
    expect((await post('/api/glasses/relay', { ...VALID, choices: ['ok', '  '] })).status).toBe(
      400,
    );
  });

  test('clamps oversized display text instead of rejecting', async () => {
    const res = await post('/api/glasses/relay', { ...VALID, text: 'あ'.repeat(300) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { item: { text: string } };
    expect(json.item.text.endsWith('…')).toBe(true);
  });

  test('non-JSON body is a 400, not a 500', async () => {
    const res = await app.request('/api/glasses/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/glasses/relay/:id/dismiss', () => {
  test('dismisses an existing item', async () => {
    const created = (await (await post('/api/glasses/relay', VALID)).json()) as {
      item: { id: string };
    };
    const res = await post(`/api/glasses/relay/${created.item.id}/dismiss`, {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; item: { dismissed: boolean } };
    expect(json.ok).toBe(true);
    expect(json.item.dismissed).toBe(true);
  });

  test('404 for an unknown id, 400 for an unsafe id', async () => {
    expect((await post('/api/glasses/relay/00000000-0000-4000-8000-000000000000/dismiss', {})).status).toBe(404);
    expect((await post('/api/glasses/relay/bad_id!/dismiss', {})).status).toBe(400);
  });
});

describe('auth placement (#504: relay is local-trust like /api/notify)', () => {
  const prevPassword = process.env[PASSWORD_ENV];
  beforeEach(() => {
    process.env[PASSWORD_ENV] = 'test-password';
  });
  afterEach(() => {
    if (prevPassword === undefined) delete process.env[PASSWORD_ENV];
    else process.env[PASSWORD_ENV] = prevPassword;
  });

  test('relay POST works WITHOUT a token even when auth is enabled', async () => {
    const res = await post('/api/glasses/relay', VALID);
    expect(res.status).toBe(200);
  });

  test('relay dismiss works WITHOUT a token even when auth is enabled', async () => {
    const created = (await (await post('/api/glasses/relay', VALID)).json()) as {
      item: { id: string };
    };
    const res = await post(`/api/glasses/relay/${created.item.id}/dismiss`, {});
    expect(res.status).toBe(200);
  });

  test('other /api/glasses routes still require auth', async () => {
    const res = await post('/api/glasses/stt', {});
    expect(res.status).toBe(401);
  });
});
