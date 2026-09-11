import type { ServerWebSocket } from 'bun';
import { describe, expect, test } from 'bun:test';
import { sendInitialSessions, sendSessionsTo, type MuxData } from '../terminal-mux';
import type { ExtendedSessionResponse } from '../../../../shared/types';

/**
 * メガネの接続が受け取る一覧フレームは、**必ず合流版**であること。
 *
 * アプリは 1 フレームを「一覧のすべて」として扱い、そこに無い id を落とす。だから
 * 素の一覧が 1 発でも混ざると peer のセッションが一度全部消え、次の合流版で末尾に
 * 付き直す = グループ順が壊れる (実機 2026-08-13: render 17 件 → 4 件 → 17 件)。
 *
 * 混ざった経路は「接続直後の 1 発」だった。メガネは接続するとすぐ
 * `subscribe-glasses-relay` を送るが、それが届くのは**最初の一覧を組み立てている
 * 最中**で、組み立て前に audience を決めていると、名乗り済みの接続へ素の一覧が飛ぶ。
 * 単発の送信関数だけを見ても再現しないので、ここでは「組み立ての最中に名乗りが届く」
 * 競走そのものを起こして押さえる。
 */

function session(id: string): ExtendedSessionResponse {
  return {
    id,
    name: id,
    createdAt: '2026-08-13T00:00:00.000Z',
    lastAccessedAt: '2026-08-13T00:00:00.000Z',
    state: 'idle',
  };
}

const LOCAL = [session('w1'), session('w2')];
const PEER = session('peer:p_a1b2:w9');

/** 合流。実運用の sessionsWithPeers と同じで、peer のぶんを足して返す。 */
const merge = async (local: ExtendedSessionResponse[]) => [...local, PEER];

interface FakeSocket {
  ws: ServerWebSocket<MuxData>;
  frames: Array<{ type: string; sessions?: ExtendedSessionResponse[] }>;
}

function socket(over: Partial<MuxData> = {}): FakeSocket {
  const frames: FakeSocket['frames'] = [];
  const ws = {
    data: { subscriptions: new Map(), conversationWatchers: new Map(), lastPingAt: 0, ...over } as MuxData,
    send: (raw: string) => { frames.push(JSON.parse(raw)); },
  } as unknown as ServerWebSocket<MuxData>;
  return { ws, frames };
}

const hasPeer = (f: { sessions?: ExtendedSessionResponse[] }) =>
  (f.sessions ?? []).some((s) => s.id === PEER.id);

describe('メガネの接続へ送る一覧', () => {
  test('組み立ての最中に「メガネです」と名乗られても、届くのは合流版', async () => {
    const { ws, frames } = socket({ isGlasses: false });

    // 一覧を組み立てている間に subscribe-glasses-relay が届く、という実機の順番。
    await sendInitialSessions(
      ws,
      async () => {
        ws.data.isGlasses = true;
        return LOCAL;
      },
      merge,
    );

    expect(frames).toHaveLength(1);
    expect(hasPeer(frames[0])).toBe(true);
  });

  test('名乗りの前に組み立てが終わっていても合流版 (判定は送る直前)', async () => {
    const { ws, frames } = socket({ isGlasses: true });

    await sendInitialSessions(ws, async () => LOCAL, merge);

    expect(hasPeer(frames[0])).toBe(true);
  });

  test('合流に失敗したら何も送らない (素の一覧を送ると peer が消える)', async () => {
    const { ws, frames } = socket({ isGlasses: true });

    await sendSessionsTo(ws, LOCAL, async () => { throw new Error('peer unreachable'); });

    expect(frames).toHaveLength(0);
  });

  test('一覧の組み立てに失敗しても素の一覧は送らない', async () => {
    const { ws, frames } = socket({ isGlasses: true });

    await sendInitialSessions(ws, async () => { throw new Error('herdr down'); }, merge);

    expect(frames).toHaveLength(0);
  });
});

describe('ブラウザの接続へ送る一覧', () => {
  test('合流していない素の一覧 (peer は各 peer の WS から自分で受け取るため)', async () => {
    const { ws, frames } = socket({ isGlasses: false });

    await sendInitialSessions(ws, async () => LOCAL, merge);

    expect(frames).toHaveLength(1);
    expect(hasPeer(frames[0])).toBe(false);
    expect(frames[0].sessions?.map((s) => s.id)).toEqual(['w1', 'w2']);
  });

  test('合流は呼ばれない (誰も読まない fanout を起こさない)', async () => {
    const { ws } = socket({ isGlasses: false });
    let merged = 0;

    await sendInitialSessions(ws, async () => LOCAL, async (l) => { merged++; return l; });

    expect(merged).toBe(0);
  });
});
