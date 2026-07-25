import { beforeEach, describe, expect, test } from 'bun:test';
import type { WorkspaceInfo } from '../herdr';
import {
  buildGlassesRelaySnapshot,
  clampDisplayWidth,
  dismissRelayItem,
  displayWidth,
  extractNumberedChoices,
  extractQuestionLine,
  glassesRelayDeps,
  normalizeRelayText,
  postAgentRelay,
  resetGlassesRelayForTest,
  subscribeGlassesRelay,
  trackGlassesRelay,
  unsubscribeGlassesRelay,
  type RelaySocket,
} from '../glasses-relay';

// =============================================================================
// Helpers
// =============================================================================

const origListWorkspaces = glassesRelayDeps.listWorkspaces;
const origReadPaneText = glassesRelayDeps.readPaneText;

beforeEach(() => {
  resetGlassesRelayForTest();
  glassesRelayDeps.listWorkspaces = origListWorkspaces;
  glassesRelayDeps.readPaneText = origReadPaneText;
});

/** Minimal WorkspaceInfo stub — only the fields the tracker reads. */
function ws(
  id: string,
  panes: Array<{ paneId: string; agentStatus: string }>,
): WorkspaceInfo {
  return {
    id,
    name: id,
    instanceId: `w-${id}`,
    createdAt: '',
    attached: false,
    panes: panes.map((p) => ({ ...p, command: 'claude', path: `/tmp/${id}`, isActive: true })),
  } as unknown as WorkspaceInfo;
}

class FakeSocket implements RelaySocket {
  messages: Array<Record<string, unknown>> = [];
  send(data: string): unknown {
    this.messages.push(JSON.parse(data));
    return 0;
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.messages.filter((m) => m.type === type);
  }
}


/** Unwrap a relay result's item or fail loudly (keeps tests free of `!`). */
function mustItem(r: { item?: { id: string; expiresAt?: number } }): { id: string; expiresAt?: number } {
  if (!r.item) throw new Error('expected an item in the relay result');
  return r.item;
}

const QUESTION_PANE = [
  'Some prior output',
  'Which approach should I take?',
  '❯ 1. Rewrite it',
  '  2. Patch minimally',
  '  3. Leave as is',
].join('\n');

// =============================================================================
// display-width clamp
// =============================================================================

describe('displayWidth / clampDisplayWidth', () => {
  test('half-width counts 1, full-width counts 2', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('a日b')).toBe(4);
  });

  test('short text passes through unchanged', () => {
    expect(clampDisplayWidth('短い', 360)).toBe('短い');
  });

  test('long text is clamped to the width budget with …', () => {
    const long = 'あ'.repeat(300); // 600 columns
    const clamped = clampDisplayWidth(long, 360);
    expect(clamped.endsWith('…')).toBe(true);
    expect(displayWidth(clamped)).toBeLessThanOrEqual(360);
  });

  test('normalizeRelayText collapses newlines and whitespace', () => {
    expect(normalizeRelayText('a\n\nb   c\td')).toBe('a b c d');
  });
});

// =============================================================================
// scrape extraction
// =============================================================================

describe('scrape extraction', () => {
  test('extractNumberedChoices reads ❯/plain numbered lines', () => {
    const choices = extractNumberedChoices([
      'Which approach?',
      '❯ 1. Rewrite it',
      '  2. Patch minimally',
      'not a choice',
    ]);
    expect(choices).toEqual(['Rewrite it', 'Patch minimally']);
  });

  test('extractQuestionLine prefers the last ?-terminated line', () => {
    expect(extractQuestionLine(['noise', 'Continue?', '❯ 1. Yes'])).toBe('Continue?');
  });

  test('extractQuestionLine falls back to the permission line', () => {
    expect(extractQuestionLine(['Do you want to proceed?', '1. Yes', '2. No'])).toBe(
      'Do you want to proceed?',
    );
  });

  test('extractQuestionLine falls back to the last non-empty line', () => {
    expect(extractQuestionLine(['', '  ', 'something odd happened'])).toBe('something odd happened');
  });
});

// =============================================================================
// agent-posted relay items (store rules)
// =============================================================================

describe('postAgentRelay store rules', () => {
  test('waiting: a second active waiting is rejected (409), dismissed one can be replaced', () => {
    const first = postAgentRelay({ sessionId: 's1', kind: 'waiting', text: 'decide?' });
    expect(first.status).toBe(200);

    const second = postAgentRelay({ sessionId: 's1', kind: 'waiting', text: 'different?' });
    expect(second.status).toBe(409);
    expect(second.item?.id).toBe(first.item?.id);

    dismissRelayItem(mustItem(first).id);
    const third = postAgentRelay({ sessionId: 's1', kind: 'waiting', text: 'new epoch?' });
    expect(third.status).toBe(200);
    expect(third.item?.id).not.toBe(first.item?.id);
  });

  test('info: latest one wins and the replaced info is removed from subscribers', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sock);
    sock.messages = [];

    const first = postAgentRelay({ sessionId: 's1', kind: 'info', text: 'one' });
    const second = postAgentRelay({ sessionId: 's1', kind: 'info', text: 'two' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const removed = sock.ofType('glasses-relay-remove').map((m) => m.id);
    expect(removed).toContain(mustItem(first).id);

    const snapshot = await buildGlassesRelaySnapshot();
    expect(snapshot.filter((i) => i.kind === 'info').map((i) => i.id)).toEqual([mustItem(second).id]);
  });

  test('info expires via TTL sweep on snapshot', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sock);

    const posted = postAgentRelay({ sessionId: 's1', kind: 'info', text: 'temporary' });
    // The returned item IS the stored object — age it past the TTL.
    mustItem(posted).expiresAt = Date.now() - 1;
    sock.messages = [];

    const snapshot = await buildGlassesRelaySnapshot();
    expect(snapshot).toHaveLength(0);
    expect(sock.ofType('glasses-relay-remove').map((m) => m.id)).toContain(mustItem(posted).id);
  });

  test('rate limit: 12 posts/min/session, the 13th is rejected', () => {
    for (let i = 0; i < 12; i++) {
      expect(postAgentRelay({ sessionId: 'flood', kind: 'info', text: `n${i}` }).status).toBe(200);
    }
    expect(postAgentRelay({ sessionId: 'flood', kind: 'info', text: 'too much' }).status).toBe(429);
    // Other sessions are unaffected.
    expect(postAgentRelay({ sessionId: 'other', kind: 'info', text: 'fine' }).status).toBe(200);
  });

  test('store cap: oldest session is evicted beyond 200 entries', () => {
    const first = postAgentRelay({ sessionId: 's-oldest', kind: 'info', text: 'old' });
    // 201 more entries: on the 202nd insert the cap eviction runs and drops
    // the oldest ('s-oldest') before adding the new one.
    for (let i = 0; i < 201; i++) {
      postAgentRelay({ sessionId: `filler-${i}`, kind: 'info', text: 'x' });
    }
    expect(dismissRelayItem(mustItem(first).id)).toBeNull();
  });
});

// =============================================================================
// blocked-transition tracker
// =============================================================================

describe('trackGlassesRelay blocked transitions', () => {
  test('baseline does not fire; a working→blocked transition creates a scraped item', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'working' }])];
    glassesRelayDeps.readPaneText = async () => QUESTION_PANE;

    await subscribeGlassesRelay(sock); // snapshot: nothing blocked → empty
    expect(sock.ofType('glasses-relay-snapshot')[0].items).toEqual([]);
    sock.messages = [];

    await trackGlassesRelay(); // seeds baseline (working)
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }])];
    await trackGlassesRelay(); // transition → item

    const upserts = sock.ofType('glasses-relay');
    expect(upserts).toHaveLength(1);
    const item = upserts[0].item as Record<string, unknown>;
    expect(item.kind).toBe('waiting');
    expect(item.source).toBe('auto');
    expect(item.sessionId).toBe('s1');
    expect(item.paneId).toBe('%0');
    expect(item.text).toBe('Which approach should I take?');
    expect(item.choices).toEqual(['Rewrite it', 'Patch minimally', 'Leave as is']);
  });

  test('presence gate: with no subscriber nothing is assembled or stored', async () => {
    let scrapeCalls = 0;
    glassesRelayDeps.readPaneText = async () => {
      scrapeCalls++;
      return QUESTION_PANE;
    };
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'working' }])];
    await trackGlassesRelay();
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }])];
    await trackGlassesRelay();

    expect(scrapeCalls).toBe(0);
    expect(await buildGlassesRelaySnapshot()).toHaveLength(0);
  });

  test('exit-blocked removes the item and broadcasts the removal', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => QUESTION_PANE;
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'working' }])];
    await subscribeGlassesRelay(sock);
    await trackGlassesRelay();
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }])];
    await trackGlassesRelay();
    const itemId = (sock.ofType('glasses-relay')[0].item as Record<string, unknown>).id;
    sock.messages = [];

    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'working' }])];
    await trackGlassesRelay();

    expect(sock.ofType('glasses-relay-remove').map((m) => m.id)).toContain(itemId);
    expect(await buildGlassesRelaySnapshot()).toHaveLength(0);
  });

  test('an agent self-note survives an unrelated pane exiting blocked (#504)', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => QUESTION_PANE;
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%1', agentStatus: 'working' }])];
    // Agent self-note posted via `cchub glasses --session` → source 'agent',
    // no paneId. It is NOT tied to any pane's blocked epoch.
    const agentItem = mustItem(postAgentRelay({ sessionId: 's1', kind: 'waiting', text: 'deploy?' }));
    await subscribeGlassesRelay(sock);
    sock.messages = [];

    // A pane of the same session goes blocked, then unblocks. Old behaviour
    // dropped the paneId-less agent item on this exit-blocked; it must not.
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%1', agentStatus: 'blocked' }])];
    await trackGlassesRelay(); // baseline (no fire)
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%1', agentStatus: 'working' }])];
    await trackGlassesRelay(); // %1 blocked→working = exit-blocked

    expect(sock.ofType('glasses-relay-remove').map((m) => m.id)).not.toContain(agentItem.id);
    const snap = await buildGlassesRelaySnapshot();
    expect(snap.map((i) => i.id)).toContain(agentItem.id);
  });

  test('dismiss suppresses re-synthesis for the same epoch; a new epoch creates a new item', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => QUESTION_PANE;
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'working' }])];
    await subscribeGlassesRelay(sock);
    await trackGlassesRelay();
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }])];
    await trackGlassesRelay();
    const itemId = (sock.ofType('glasses-relay')[0].item as Record<string, unknown>).id as string;

    dismissRelayItem(itemId);
    // Snapshot while still blocked: dismissed item stays hidden, no re-synthesis.
    expect(await buildGlassesRelaySnapshot()).toHaveLength(0);

    // blocked→working→blocked = a NEW epoch → a NEW item (dismiss not inherited).
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'working' }])];
    await trackGlassesRelay();
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }])];
    await trackGlassesRelay();
    const upsertIds = sock.ofType('glasses-relay').map((m) => (m.item as Record<string, unknown>).id);
    const newIds = upsertIds.filter((id) => id !== itemId);
    expect(newIds.length).toBeGreaterThan(0);
  });

  test('workspace disappearance drops its items (another workspace still present)', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => QUESTION_PANE;
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }]),
      ws('s2', [{ paneId: '%0', agentStatus: 'working' }]),
    ];
    await subscribeGlassesRelay(sock); // snapshot synthesizes s1's waiting item
    const itemId = (sock.ofType('glasses-relay')[0].item as Record<string, unknown>).id;
    sock.messages = [];

    glassesRelayDeps.listWorkspaces = async () => [ws('s2', [{ paneId: '%0', agentStatus: 'working' }])];
    await trackGlassesRelay();
    expect(sock.ofType('glasses-relay-remove').map((m) => m.id)).toContain(itemId);
  });

  test('an empty workspace list (herdr blip) does NOT wipe the store', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => QUESTION_PANE;
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }])];
    await subscribeGlassesRelay(sock);
    expect(sock.ofType('glasses-relay')).toHaveLength(1);

    glassesRelayDeps.listWorkspaces = async () => [];
    await trackGlassesRelay();
    expect(sock.ofType('glasses-relay-remove')).toHaveLength(0);
  });

  test('snapshot prunes a stale auto item whose blocked epoch ended untracked', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => QUESTION_PANE;
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }])];
    await subscribeGlassesRelay(sock);
    expect(sock.ofType('glasses-relay')).toHaveLength(1);
    const itemId = (sock.ofType('glasses-relay')[0].item as Record<string, unknown>).id;
    sock.messages = [];

    // Blocked resolved while tracking was off (e.g. no mux connections): the
    // next snapshot must prune the stale auto item instead of showing it.
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'working' }])];
    const snapshot = await buildGlassesRelaySnapshot();
    expect(snapshot).toHaveLength(0);
    expect(sock.ofType('glasses-relay-remove').map((m) => m.id)).toContain(itemId);
  });
});

describe('snapshot ordering', () => {
  test('waiting first, then info, oldest first within a kind', async () => {
    glassesRelayDeps.listWorkspaces = async () => [];
    postAgentRelay({ sessionId: 'a', kind: 'info', text: 'fyi' });
    postAgentRelay({ sessionId: 'b', kind: 'waiting', text: 'decide?' });
    const snapshot = await buildGlassesRelaySnapshot();
    expect(snapshot.map((i) => i.kind)).toEqual(['waiting', 'info']);
  });

  test('unsubscribe stops deliveries', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sock);
    unsubscribeGlassesRelay(sock);
    sock.messages = [];
    postAgentRelay({ sessionId: 'a', kind: 'info', text: 'fyi' });
    expect(sock.messages).toHaveLength(0);
  });
});
