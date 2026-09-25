/**
 * The glasses talk to one machine, so a question raised on another one has to
 * be folded in here or it never reaches a card. What is tested is the folding
 * and its differences - the pane reading it comes from is each peer's own.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  buildGlassesRelaySnapshot,
  dismissRelayItem,
  postHookRelay,
  glassesRelayDeps,
  resetGlassesRelayForTest,
  subscribeGlassesRelay,
  trackGlassesRelay,
  type RelaySocket,
} from '../glasses-relay';
import type { GlassesRelayItem } from '../../../../shared/types';

function peerItem(over: Partial<GlassesRelayItem> = {}): GlassesRelayItem {
  return {
    id: 'peer:p_mac:w2H-1',
    kind: 'waiting',
    sessionId: 'peer:p_mac:w2H',
    paneId: '%1',
    text: 'Which one?',
    createdAt: 1,
    ...over,
  } as GlassesRelayItem;
}

function socket(): { ws: RelaySocket; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    ws: { send: (s: string) => sent.push(JSON.parse(s)) } as unknown as RelaySocket,
    sent,
  };
}

describe('the id a peer item carries', () => {
  test('is accepted by the route that retires it', async () => {
    // The wearer's "later" is the only thing that can retire one of these: the
    // machine that raised it keeps reporting it, correctly, because its pane is
    // still blocked. Rejected on the colons, every dismissal returned 400 and
    // the card came straight back.
    const { glassesRelay } = await import('../../routes/glasses-relay');
    resetGlassesRelayForTest();
    glassesRelayDeps.listPeerRelayItems = async () => [peerItem()];
    await trackGlassesRelay();

    const res = await glassesRelay.request('/peer:p_mac:w2H-1/dismiss', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await buildGlassesRelaySnapshot()).toEqual([]);
  });
});

describe("another machine's completions", () => {
  beforeEach(() => {
    resetGlassesRelayForTest();
    glassesRelayDeps.listWorkspaces = async () => [];
    glassesRelayDeps.listPeerRelayItems = async () => [];
  });

  test('are recorded even though nobody is wearing glasses on it', async () => {
    // A question survives being dropped - the pane is still blocked, so it can
    // be assembled later. A completion happens once. Dropped because nothing
    // was subscribed to *this* machine, it never reaches the wearer on the
    // other one, and there is nothing left to recover it from.
    postHookRelay({ sessionId: 'w2H', text: 'Response complete', paneId: '%1' });

    const items = await buildGlassesRelaySnapshot({ peers: false, force: true });
    expect(items.map((i) => [i.kind, i.text])).toEqual([['info', 'Response complete']]);
  });

  test('still report that they reached nobody here', async () => {
    // The caller uses this to decide whether the browser should notify as well,
    // and this machine cannot know whether the wearer on the other one saw it.
    // A duplicate notification beats a lost one.
    expect(postHookRelay({ sessionId: 'w2H', text: 'done' })).toBe(false);
  });
});

describe("another machine's questions", () => {
  beforeEach(() => {
    resetGlassesRelayForTest();
    glassesRelayDeps.listWorkspaces = async () => [];
    glassesRelayDeps.listPeerRelayItems = async () => [];
  });

  test('are assembled for a machine nobody is wearing glasses on', async () => {
    // The gate that skips assembly when nothing is subscribed is right for the
    // ordinary case and wrong for this one: the wearer is on the machine doing
    // the asking, and nobody will ever subscribe here.
    glassesRelayDeps.listWorkspaces = async () => [
      {
        id: 'w2H',
        name: 'herdr-pilot',
        instanceId: 'w2H',
        panes: [{ paneId: '%1', agent: 'claude', agentSessionId: 's1', agentStatus: 'blocked' }],
      } as never,
    ];
    glassesRelayDeps.readPaneText = async () => 'Which colour?';
    glassesRelayDeps.readAgentQuestions = async () => ({
      known: true,
      questions: [
        { question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] },
      ] as never,
    });

    expect(await buildGlassesRelaySnapshot({ peers: false })).toEqual([]);
    const forced = await buildGlassesRelaySnapshot({ peers: false, force: true });
    expect(forced.map((i) => i.choices)).toEqual([['Red', 'Blue']]);
  });

  test('reach the snapshot a wearer gets on connecting', async () => {
    glassesRelayDeps.listPeerRelayItems = async () => [peerItem()];
    await trackGlassesRelay();

    expect((await buildGlassesRelaySnapshot()).map((i) => i.sessionId)).toEqual(['peer:p_mac:w2H']);
  });

  test('are pushed once rather than on every sweep', async () => {
    glassesRelayDeps.listPeerRelayItems = async () => [peerItem()];
    const { ws, sent } = socket();
    await subscribeGlassesRelay(ws);
    sent.length = 0;

    await trackGlassesRelay();
    await trackGlassesRelay();

    // The pane is scraped again each sweep, so the same question arrives again
    // as an equal object. Told twice, it takes the screen twice.
    expect(sent.filter((m) => m.type === 'glasses-relay')).toHaveLength(1);
  });

  test('does not hand a peer back the items it lent us', async () => {
    // Each machine merges the other's set. Answering with the merged one puts
    // a question in a loop between the two, and the wearer sees it twice.
    glassesRelayDeps.listPeerRelayItems = async () => [peerItem()];
    await trackGlassesRelay();

    expect(await buildGlassesRelaySnapshot({ peers: false })).toEqual([]);
    expect((await buildGlassesRelaySnapshot()).map((i) => i.id)).toEqual(['peer:p_mac:w2H-1']);
  });

  test("stay put off, though the machine that asked keeps asking", async () => {
    // "Later" cannot be answered over there: that pane is still blocked, and
    // rightly so. Answered here or not at all, or the card returns on the next
    // sweep and the wearer cannot get off it.
    glassesRelayDeps.listPeerRelayItems = async () => [peerItem()];
    const { ws, sent } = socket();
    await subscribeGlassesRelay(ws);
    await trackGlassesRelay();

    dismissRelayItem('peer:p_mac:w2H-1');
    sent.length = 0;
    await trackGlassesRelay();

    expect(await buildGlassesRelaySnapshot()).toEqual([]);
    expect(sent.filter((m) => m.type === 'glasses-relay')).toHaveLength(0);
  });

  test('are offered again once the machine stops asking and asks afresh', async () => {
    glassesRelayDeps.listPeerRelayItems = async () => [peerItem()];
    await trackGlassesRelay();
    dismissRelayItem('peer:p_mac:w2H-1');

    // The question ended over there.
    glassesRelayDeps.listPeerRelayItems = async () => [];
    await trackGlassesRelay();
    // And a new one arrived under the same id, which is what happens when the
    // pane blocks again.
    glassesRelayDeps.listPeerRelayItems = async () => [peerItem({ text: 'Something else?' })];
    await trackGlassesRelay();

    expect((await buildGlassesRelaySnapshot()).map((i) => i.text)).toEqual(['Something else?']);
  });

  test('are withdrawn when the peer stops asking', async () => {
    glassesRelayDeps.listPeerRelayItems = async () => [peerItem()];
    const { ws, sent } = socket();
    await subscribeGlassesRelay(ws);
    await trackGlassesRelay();
    sent.length = 0;

    glassesRelayDeps.listPeerRelayItems = async () => [];
    await trackGlassesRelay();

    expect(sent.some((m) => m.type === 'glasses-relay-remove')).toBe(true);
    expect(await buildGlassesRelaySnapshot()).toEqual([]);
  });

  test('survive a sweep that could not reach the peer', async () => {
    // An unreachable machine answers with nothing, and nothing is not "the
    // question was answered" - retracting the card would take a decision off
    // the wearer's face because a network blinked.
    glassesRelayDeps.listPeerRelayItems = async () => [peerItem()];
    await trackGlassesRelay();
    glassesRelayDeps.listPeerRelayItems = async () => {
      throw new Error('unreachable');
    };
    await trackGlassesRelay();

    expect((await buildGlassesRelaySnapshot()).map((i) => i.id)).toEqual(['peer:p_mac:w2H-1']);
  });
});
