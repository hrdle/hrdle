import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IDENTITY } from '../../../../shared/identity';

/**
 * peer のセッション宛の要求が、その機械へ渡ること。
 *
 * メガネは受け取った id をそのまま URL に載せて返してくるだけなので、ここで
 * 「peer のものだと気づいて、相手の id に戻して転送する」に失敗すると、返答は
 * 黙ってこの機械の herdr に向かう。分岐を間違えた時に落ちるのではなく別の
 * 機械へ喋ってしまう類の壊れ方なので、経路そのものを押さえておく。
 *
 * peer レジストリは data dir のファイルなので、import より先に temp を掴む。
 */
process.env[IDENTITY.dataDirEnv] = mkdtempSync(join(tmpdir(), 'peer-proxy-'));

const { sessions } = await import('../sessions');
const { createPeer, deletePeer } = await import('../../services/peer-registry');
const { makePeerSessionId, resetPeerSessionsCache } = await import('../../services/peer-sessions');

const realFetch = globalThis.fetch;
const created: string[] = [];

interface SeenRequest {
  url: string;
  method: string;
  body: string;
}

function stubFetch(response: () => Response): SeenRequest[] {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return response();
  }) as typeof fetch;
  return seen;
}

async function addPeer() {
  const peer = await createPeer({
    nickname: 'MAC',
    url: 'https://mac.example.ts.net',
    wsToken: 'token',
  });
  created.push(peer.id);
  return peer;
}

beforeEach(() => {
  resetPeerSessionsCache();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const id of created.splice(0)) await deletePeer(id);
  resetPeerSessionsCache();
});

describe('peer のセッション宛の転送', () => {
  test('会話は書き起こしを持つ機械に聞きに行く (id は相手のものに戻す)', async () => {
    const peer = await addPeer();
    const seen = stubFetch(() => Response.json({ messages: [{ role: 'assistant', content: 'hi' }] }));

    const id = makePeerSessionId(peer.id, 'cc-uuid');
    const res = await sessions.request(`/history/${encodeURIComponent(id)}/conversation?last=10`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [{ role: 'assistant', content: 'hi' }] });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(
      'https://mac.example.ts.net/api/sessions/history/cc-uuid/conversation?last=10',
    );
  });

  test('返答はそのまま相手の同じ入口へ渡す (paneId は相手の値のまま)', async () => {
    const peer = await addPeer();
    const seen = stubFetch(() => Response.json({ success: true, paneId: '%3' }));

    const res = await sessions.request(
      `/${encodeURIComponent(makePeerSessionId(peer.id, 'w1'))}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'こんにちは', paneId: '%3' }),
      },
    );

    expect(res.status).toBe(200);
    expect(seen[0].url).toBe('https://mac.example.ts.net/api/sessions/w1/prompt');
    expect(seen[0].method).toBe('POST');
    expect(JSON.parse(seen[0].body)).toEqual({ text: 'こんにちは', paneId: '%3' });
  });

  test('キー入力 (選択肢の返事) も同じ経路を通る', async () => {
    const peer = await addPeer();
    const seen = stubFetch(() => Response.json({ success: true }));

    await sessions.request(
      `/${encodeURIComponent(makePeerSessionId(peer.id, 'w1'))}/panes/input`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paneId: '%3', data: '\r' }),
      },
    );

    expect(seen[0].url).toBe('https://mac.example.ts.net/api/sessions/w1/panes/input');
    expect(JSON.parse(seen[0].body)).toEqual({ paneId: '%3', data: '\r' });
  });

  test('相手が答えた失敗はそのまま返す (成功に見せない)', async () => {
    const peer = await addPeer();
    stubFetch(() => Response.json({ error: 'Session not found' }, { status: 404 }));

    const res = await sessions.request(
      `/${encodeURIComponent(makePeerSessionId(peer.id, 'gone'))}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      },
    );

    expect(res.status).toBe(404);
  });

  test('届かない機械宛は 502 (この機械のセッションへ向け直さない)', async () => {
    const peer = await addPeer();
    stubFetch(() => { throw new Error('connect ECONNREFUSED'); });

    const res = await sessions.request(
      `/${encodeURIComponent(makePeerSessionId(peer.id, 'w1'))}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      },
    );

    expect(res.status).toBe(502);
  });

  test('知らない peer の id は 404 (登録を消した後の古い id)', async () => {
    const seen = stubFetch(() => Response.json({ success: true }));

    const res = await sessions.request(
      `/${encodeURIComponent(makePeerSessionId('p_deadbeef', 'w1'))}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      },
    );

    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});
