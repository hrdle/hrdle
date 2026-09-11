import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IDENTITY } from '../../../../shared/identity';
import { LOCAL_PEER_ID, type ExtendedSessionResponse } from '../../../../shared/types';

/**
 * メガネから peer のセッションを見る経路のテスト。
 *
 * メガネのアプリは id を触らずに投げ返すだけなので、「id に peer を載せて、
 * 返ってきたら剥がして転送する」が壊れていないことがこの機能の全体である。
 *
 * peer レジストリは data dir のファイルなので、import より先に temp を掴む。
 */
process.env[IDENTITY.dataDirEnv] = mkdtempSync(join(tmpdir(), 'peer-sessions-'));

const {
  makePeerSessionId,
  parsePeerSessionId,
  namespacePeerSession,
  listPeerSessions,
  sessionsWithPeers,
  sortByPeerOrder,
  resetPeerSessionsCache,
} = await import('../peer-sessions');
const { createPeer, deletePeer, listPeers, setPeerOrder } = await import('../peer-registry');

function session(over: Partial<ExtendedSessionResponse> = {}): ExtendedSessionResponse {
  return {
    id: 'w1',
    name: 'hrdle',
    createdAt: '2026-08-13T00:00:00.000Z',
    lastAccessedAt: '2026-08-13T00:00:00.000Z',
    state: 'idle',
    ...over,
  };
}

describe('id の往復', () => {
  test('付けた peer と元の id がそのまま戻る', () => {
    const ref = parsePeerSessionId(makePeerSessionId('p_a1b2', 'w1'));
    expect(ref).toEqual({ peerId: 'p_a1b2', localId: 'w1' });
  });

  test('元の id にコロンが入っていても分かれ目を間違えない', () => {
    const ref = parsePeerSessionId(makePeerSessionId('p_a1b2', 'w1:t2:%3'));
    expect(ref).toEqual({ peerId: 'p_a1b2', localId: 'w1:t2:%3' });
  });

  test('この機械自身の id は peer ではないと答える', () => {
    expect(parsePeerSessionId('w1')).toBeNull();
    expect(parsePeerSessionId('550e8400-e29b-41d4-a716-446655440000')).toBeNull();
  });

  test('欠けた形は peer として受け取らない', () => {
    expect(parsePeerSessionId('peer:')).toBeNull();
    expect(parsePeerSessionId('peer:p_a1b2')).toBeNull();
    expect(parsePeerSessionId('peer:p_a1b2:')).toBeNull();
    expect(parsePeerSessionId('peer::w1')).toBeNull();
  });

  test('相手のパスを遡る形は受け取らない', () => {
    // encodeURIComponent は `..` をそのまま通し、fetch がそれを解決してしまう。
    expect(parsePeerSessionId('peer:p_a1b2:..')).toBeNull();
    expect(parsePeerSessionId('peer:p_a1b2:.')).toBeNull();
  });
});

describe('peer のセッションに宛名を付ける', () => {
  const peer = { id: 'p_a1b2', nickname: 'MAC', color: '#f00' };

  test('メガネが投げ返す id を全部書き換える', () => {
    const out = namespacePeerSession(
      session({
        ccSessionId: 'cc-uuid',
        agentSessionId: 'agent-uuid',
        panes: [
          { paneId: '%1', isActive: true, agentSessionId: 'pane-uuid' },
          { paneId: '%2', isActive: false },
        ],
      }),
      peer,
    );

    expect(out.id).toBe('peer:p_a1b2:w1');
    expect(out.ccSessionId).toBe('peer:p_a1b2:cc-uuid');
    expect(out.agentSessionId).toBe('peer:p_a1b2:agent-uuid');
    expect(out.panes?.[0].agentSessionId).toBe('peer:p_a1b2:pane-uuid');
    // 会話 id を持たない pane は持たないまま (空文字の id を作らない)。
    expect(out.panes?.[1].agentSessionId).toBeUndefined();
  });

  test('paneId は触らない (相手の値をそのまま返すため)', () => {
    const out = namespacePeerSession(
      session({ panes: [{ paneId: '%1', isActive: true }] }),
      peer,
    );
    expect(out.panes?.[0].paneId).toBe('%1');
  });

  test('どの機械のものか名前で分かる', () => {
    expect(namespacePeerSession(session(), peer).name).toBe('MAC/hrdle');
  });

  test('相手が customTitle を持つ時はそちらに付ける (メガネはそれを優先して描く)', () => {
    const out = namespacePeerSession(session({ customTitle: '旧タイトル' }), peer);
    expect(out.customTitle).toBe('MAC/旧タイトル');
    expect(out.name).toBe('hrdle');
  });

  test('どの peer のものかを構造化された形でも残す', () => {
    const out = namespacePeerSession(session(), peer);
    expect(out.peerId).toBe('p_a1b2');
    expect(out.peerNickname).toBe('MAC');
  });
});

describe('並びの正本 (peers 設定の order)', () => {
  test('order の小さい順', () => {
    const sorted = sortByPeerOrder([{ order: 2, id: 'b' }, { order: 0, id: 'a' }, { order: 1, id: 'c' }]);
    expect(sorted.map(x => x.id)).toEqual(['a', 'c', 'b']);
  });

  test('order を持たない (古い保存の) peer は末尾', () => {
    const sorted = sortByPeerOrder([{ id: 'no-order' }, { order: 5, id: 'has-order' }]);
    expect(sorted.map(x => x.id)).toEqual(['has-order', 'no-order']);
  });

  test('order が数でない場合も末尾 (壊れた保存で先頭に居座らせない)', () => {
    const sorted = sortByPeerOrder([
      { order: Number.NaN, id: 'broken' },
      { order: 3, id: 'ok' },
    ]);
    expect(sorted.map(x => x.id)).toEqual(['ok', 'broken']);
  });

  test('同じ order は元の並びのまま', () => {
    const sorted = sortByPeerOrder([{ order: 1, id: 'first' }, { order: 1, id: 'second' }]);
    expect(sorted.map(x => x.id)).toEqual(['first', 'second']);
  });
});

describe('一覧のマージ', () => {
  const realFetch = globalThis.fetch;
  const created: string[] = [];

  function stubFetch(handler: (url: string) => Response): string[] {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      return handler(url);
    }) as typeof fetch;
    return seen;
  }

  const sessionsBody = (...ids: string[]) =>
    Response.json({ sessions: ids.map(id => session({ id, name: id })) });

  beforeEach(() => {
    resetPeerSessionsCache();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    for (const id of created.splice(0)) await deletePeer(id);
    // 並び替えは保存される。次のテストへ持ち越さないよう既定 (自分が先頭) に戻す。
    await setPeerOrder([LOCAL_PEER_ID]);
    resetPeerSessionsCache();
  });

  async function addPeer(nickname: string, host: string) {
    const peer = await createPeer({
      nickname,
      url: `https://${host}.example.ts.net`,
      wsToken: 'token',
    });
    created.push(peer.id);
    return peer;
  }

  test('相手には「自分のぶんだけ」を要求する (peer 越しの peer を連れてこない)', async () => {
    await addPeer('MAC', 'mac');
    const seen = stubFetch(() => sessionsBody('w1'));

    await listPeerSessions();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/api/sessions?local=1');
  });

  test('返ってきたセッションに peer の宛名が付く', async () => {
    const peer = await addPeer('MAC', 'mac');
    stubFetch(() => sessionsBody('w1'));

    const merged = await sessionsWithPeers([session({ id: 'local-1' })]);

    expect(merged.map(s => s.id)).toEqual(['local-1', `peer:${peer.id}:w1`]);
    expect(merged[1].peerNickname).toBe('MAC');
  });

  test('peer がいる時は自分のセッションにも機械の名札が付く (メガネの端末画面が並べる)', async () => {
    await addPeer('MAC', 'mac');
    stubFetch(() => sessionsBody('w1'));

    const merged = await sessionsWithPeers([session({ id: 'local-1' })]);

    expect(merged[0].peerId).toBe(LOCAL_PEER_ID);
    expect(merged[0].peerNickname).toBe('Local');
  });

  test('peer がいなければ自分のセッションはそのまま (名札も無い)', async () => {
    const merged = await sessionsWithPeers([session({ id: 'local-1' })]);

    expect(merged[0].peerId).toBeUndefined();
  });

  test('落ちている peer があっても、答えた peer の一覧は返る', async () => {
    await addPeer('MAC', 'mac');
    const lab = await addPeer('LAB', 'lab');
    stubFetch((url) => {
      if (url.includes('mac')) throw new Error('connect ECONNREFUSED');
      return sessionsBody('w9');
    });

    const merged = await sessionsWithPeers([]);

    expect(merged.map(s => s.id)).toEqual([`peer:${lab.id}:w9`]);
  });

  test('相手が自分の peer のぶんまで返してきたら捨てる', async () => {
    const peer = await addPeer('MAC', 'mac');
    stubFetch(() => Response.json({
      sessions: [session({ id: 'w1' }), session({ id: 'peer:p_other:w2' })],
    }));

    const merged = await sessionsWithPeers([]);

    expect(merged.map(s => s.id)).toEqual([`peer:${peer.id}:w1`]);
  });

  test('立て続けの問い合わせは 1 回で済ませる (5 秒ごとの push が peer を叩き続けないため)', async () => {
    await addPeer('MAC', 'mac');
    const seen = stubFetch(() => sessionsBody('w1'));

    await Promise.all([listPeerSessions(), listPeerSessions()]);
    await listPeerSessions();

    expect(seen).toHaveLength(1);
  });

  test('peers 設定の order で並ぶ — 自分が先頭とは限らない', async () => {
    const mac = await addPeer('MAC', 'mac');
    stubFetch(() => sessionsBody('w1'));

    // 「MAC を一番上に」= peers 設定の並び替え。自分 (local) はその下。
    await setPeerOrder([mac.id, LOCAL_PEER_ID]);
    resetPeerSessionsCache();

    const merged = await sessionsWithPeers([session({ id: 'local-1' })]);

    expect(merged.map(s => s.id)).toEqual([`peer:${mac.id}:w1`, 'local-1']);
  });

  test('自分 (local) の位置も保存される', async () => {
    // listPeers は保存が無ければ order 0 の local を合成して返すので、実体化まで
    // やらないと「MAC を上に」の指定が黙って捨てられる。
    const mac = await addPeer('MAC', 'mac');

    await setPeerOrder([mac.id, LOCAL_PEER_ID]);

    expect((await listPeers()).find(p => p.id === LOCAL_PEER_ID)?.order).toBe(1);
  });

  test('並べ替えると合流の順も変わる (順番の正本は 1 つ)', async () => {
    const mac = await addPeer('MAC', 'mac');
    stubFetch(() => sessionsBody('w1'));

    await setPeerOrder([LOCAL_PEER_ID, mac.id]);
    resetPeerSessionsCache();
    const localFirst = await sessionsWithPeers([session({ id: 'local-1' })]);

    await setPeerOrder([mac.id, LOCAL_PEER_ID]);
    resetPeerSessionsCache();
    const macFirst = await sessionsWithPeers([session({ id: 'local-1' })]);

    expect(localFirst.map(s => s.id)).toEqual(['local-1', `peer:${mac.id}:w1`]);
    expect(macFirst.map(s => s.id)).toEqual([`peer:${mac.id}:w1`, 'local-1']);
  });

  test('peer が 1 台も登録されていなければ、渡された一覧をそのまま返す', async () => {
    expect((await listPeers()).every(p => p.url === 'self')).toBe(true);
    const local = [session({ id: 'local-1' })];

    expect(await sessionsWithPeers(local)).toBe(local);
  });
});
