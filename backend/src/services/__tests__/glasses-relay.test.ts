import { beforeEach, describe, expect, test } from 'bun:test';
import type { WorkspaceInfo } from '../herdr';
import {
  buildGlassesRelaySnapshot,
  clampDisplayWidth,
  dismissRelayItem,
  displayWidth,
  extractNumberedChoices,
  extractPermissionRequest,
  extractQuestionLine,
  glassesDeviceCount,
  glassesRelayDeps,
  normalizeRelayText,
  optionBlockStart,
  postAgentRelay,
  postHookRelay,
  resetGlassesRelayForTest,
  resolveHookTarget,
  stripLeftRule,
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
  // The coloured read is a second round trip taken only when the plain one
  // found no options, so it fires for every pane in here that is not offering a
  // list. Stubbed empty by default rather than restored: a unit test must not
  // reach for a herdr socket, and every pane below whose options DO matter says
  // so for itself.
  glassesRelayDeps.readPaneAnsi = async () => null;
});

/**
 * An opencode permission prompt, captured from a live 1.18.14 pane 121 columns
 * wide (2026-08-06). Two things about it broke this file:
 *
 * - every line is framed with a rule, and every pattern here anchors at the
 *   start of a line, so nothing matched and nothing could have
 * - the question ends in no `?` and says no `Do you want to`, so the fallback
 *   ran and the notification a wearer got was the rule itself: one glyph
 *
 * Only the options row carries its colours, because it is the only row whose
 * colours are read. It is verbatim; the rest is the same pane as text.
 */
const OPENCODE_OPTION_ROW = '\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;10;10;10m  \x1b[0m\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;245;167;66m \x1b[0m\x1b[38;2;10;10;10m\x1b[48;2;245;167;66mAllow once\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;245;167;66m \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mAllow always\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m   \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mReject\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m                                 \x1b[0m\x1b[38;2;238;238;238m\x1b[48;2;30;30;30mctrl+f \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mfullscreen\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;238;238;238m\x1b[48;2;30;30;30m⇆ \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mselect\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;2;238;238;238m\x1b[48;2;30;30;30menter \x1b[0m\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mconfirm\x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m   \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;10;10;10m  \x1b[0m\r';

const OPENCODE_PANE = [
  '  \u2503',
  '  \u2503  \u25b3 Permission required',
  '  \u2503    \u2192 Edit fixture.txt',
  '  \u2503',
  '  \u2503  1 + fixture',
  '  \u2503',
  '  \u2503   Allow once   Allow always   Reject                                 ctrl+f fullscreen  \u21c6 select  enter confirm',
  '  \u2503',
].join('\n');

const OPENCODE_PANE_ANSI = [
  '  \u2503',
  '  \u2503  \u25b3 Permission required',
  '  \u2503    \u2192 Edit fixture.txt',
  '  \u2503',
  '  \u2503  1 + fixture',
  '  \u2503',
  OPENCODE_OPTION_ROW,
  '  \u2503',
].join('\n');

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

  test("extractNumberedChoices reads kimi's bracketed options", () => {
    // Captured from a real kimi-k3 pane on 2026-08-04. herdr's `strip_ansi`
    // removes the colour and leaves the U+2192 cursor, so this is what the
    // scrape actually receives. None of it was read before: a blocked kimi
    // workspace produced a waiting item with no choices and the picker never
    // opened for it.
    const choices = extractNumberedChoices([
      '  ? テストはどう分けますか?',
      '',
      '   → [1] モジュールごとに1ファイル',
      '         各モジュールに対応するテストファイルを個別に作成します',
      '     [2] 全部で1ファイル',
      '         すべてのテストを1つのファイルにまとめます',
      '     [3] Other',
      '',
      '   ↑↓ select  1-3 / ↵ choose  ←/→/tab switch  esc cancel',
    ]);
    // The description under each label comes with it. Without it the wearer
    // gets labels that name nothing - `案A / 案B / 案C` on 2026-08-08, where
    // every word that told them apart was on the line below.
    expect(choices).toEqual([
      'モジュールごとに1ファイル - 各モジュールに対応するテストファイルを個別に作成します',
      '全部で1ファイル - すべてのテストを1つのファイルにまとめます',
    ]);
  });

  test('extractNumberedChoices keeps the footer hints out of a description', () => {
    // The hints sit left of the labels, so indentation alone rejects them.
    expect(
      extractNumberedChoices([
        '      [1] 案 A (Recommended)',
        '          現行のトーンに一番近い',
        '      [2] 案 B',
        '  ↑↓ select  1-2 / ↵ choose  ←/→/tab switch  esc cancel',
      ]),
    ).toEqual(['案 A (Recommended) - 現行のトーンに一番近い', '案 B']);
  });

  test('extractNumberedChoices rejoins a description the pane wrapped', () => {
    // Captured from the live kimi pane on 2026-08-08: the description ran past
    // the column and the terminal broke it mid-word. Joined with a space, the
    // wearer reads `スマホやG2か ら` - a space that was never written.
    expect(
      extractNumberedChoices([
        '      [1] 案A (Recommended)',
        '          現行の動詞列の構成を活かしつつ「スマホやG2か',
        '          ら」を明示',
      ]),
    ).toEqual(['案A (Recommended) - 現行の動詞列の構成を活かしつつ「スマホやG2から」を明示']);
  });

  test('extractNumberedChoices keeps the space latin wrapping consumed', () => {
    expect(
      extractNumberedChoices([
        '      [1] Rewrite',
        '          start again from the',
        '          current interface',
      ]),
    ).toEqual(['Rewrite - start again from the current interface']);
  });

  test('extractNumberedChoices cuts a description that runs long', () => {
    const [only] = extractNumberedChoices([
      '  [1] Yes',
      `      ${'x'.repeat(200)}`,
      '  [2] No',
    ]);
    expect(only.length).toBeLessThan(100);
    expect(only.startsWith('Yes - xxx')).toBe(true);
    expect(only.endsWith('…')).toBe(true);
  });

  test("extractNumberedChoices reads kimi's submit screen", () => {
    expect(
      extractNumberedChoices(['  Ready to submit your answers?', '', '   → [1] Submit', '     [2] Cancel']),
    ).toEqual(['Submit', 'Cancel']);
  });

  test('extractNumberedChoices drops the rows the ring cannot answer', () => {
    // All three open free-text entry, which the ring has no keyboard for.
    // `Other` is kimi's; the other two are claude's.
    expect(
      extractNumberedChoices([
        '❯ 1. Rewrite it',
        '  2. Patch minimally',
        '  3. Type something.',
        '  4. Chat about this',
      ]),
    ).toEqual(['Rewrite it', 'Patch minimally']);
    expect(extractNumberedChoices(['   → [1] Keep it', '     [2] Other'])).toEqual(['Keep it']);
  });

  test("extractNumberedChoices reads claude's multi-select, boxes and all", () => {
    // Captured from a live Claude Code pane on 2026-08-06. The box has to
    // survive: it is the only thing that tells the app this is a multi-select
    // rather than a single pick, and which rows the wearer has already ticked.
    expect(
      extractNumberedChoices([
        '←  ☒ Color  ☐ Fruits  ☐ Speed  ✔ Submit  →',
        '',
        'Which fruits do you like?',
        '',
        '❯ 1. [ ] Apple',
        '  Crisp and sweet-tart.',
        '  2. [ ] Banana',
        '  Soft and sweet.',
        '  3. [✔] Cherry',
        '  Small and tangy-sweet.',
        '  4. [ ] Type something',
        '     Next',
        '',
        '  5. Chat about this',
      ]),
    ).toEqual(['[ ] Apple', '[ ] Banana', '[✔] Cherry']);
  });

  test("extractNumberedChoices reads kimi's unnumbered multi-select", () => {
    // Also captured on 2026-08-06, and the reason the whole multi-step fix
    // still failed on kimi: its multi-select draws no digits at all, so
    // nothing here matched, the payload came back with no choices, and
    // `refreshBlocked` kept the previous question rather than replace it with
    // an empty one. The panel showed question one while the pane was on
    // question two — the quiet failure this path exists to prevent.
    expect(
      extractNumberedChoices([
        '  question',
        '',
        '  (✓) Color   Fruits   (○) Speed   Submit',
        '',
        '  ? Which fruits do you like?',
        '',
        '   [ ] Apple',
        '   [✓] Banana',
        '   [ ] Cherry',
        '   [ ] Other',
        '',
        '   ↑↓ select  1-4 / ↵ toggle  ←/→/tab switch  esc cancel',
      ]),
    ).toEqual(['[ ] Apple', '[✓] Banana', '[ ] Cherry']);
  });

  test('extractNumberedChoices drops a free-text row whatever punctuation it wears', () => {
    // `Type something.` in a single pick, `[ ] Type something` in a
    // multi-select, and kimi's `Other:` once it is the field being typed into.
    // Compared literally, only the first was caught.
    expect(extractNumberedChoices(['1. [ ] Keep it', '2. [ ] Type something'])).toEqual([
      '[ ] Keep it',
    ]);
    expect(extractNumberedChoices(['   [ ] Keep it', '   [ ] Other:'])).toEqual(['[ ] Keep it']);
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

// =============================================================================
// still-blocked refresh (multi-step AskUserQuestion)
// =============================================================================

describe('trackGlassesRelay refresh while still blocked', () => {
  const SECOND_QUESTION = [
    'Which approach should I take?',
    'And how should the tests be split?',
    '❯ 1. One file per module',
    '  2. One file for the lot',
  ].join('\n');

  /** Blocked with the first question up, one subscriber watching. */
  async function blockedOnFirstQuestion(): Promise<{ sock: FakeSocket; itemId: string }> {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => QUESTION_PANE;
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'working' }])];
    await subscribeGlassesRelay(sock);
    await trackGlassesRelay();
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }])];
    await trackGlassesRelay();
    const itemId = (sock.ofType('glasses-relay')[0].item as Record<string, unknown>).id as string;
    sock.messages = [];
    return { sock, itemId };
  }

  test('a new question on a pane that never unblocked replaces the item', async () => {
    const { sock, itemId } = await blockedOnFirstQuestion();

    glassesRelayDeps.readPaneText = async () => SECOND_QUESTION;
    await trackGlassesRelay();

    expect(sock.ofType('glasses-relay-remove').map((m) => m.id)).toContain(itemId);
    const upserts = sock.ofType('glasses-relay');
    expect(upserts).toHaveLength(1);
    const item = upserts[0].item as Record<string, unknown>;
    expect(item.id).not.toBe(itemId);
    expect(item.text).toBe('And how should the tests be split?');
    expect(item.choices).toEqual(['One file per module', 'One file for the lot']);
  });

  test('an unchanged pane broadcasts nothing', async () => {
    const { sock } = await blockedOnFirstQuestion();
    await trackGlassesRelay();
    await trackGlassesRelay();
    expect(sock.messages).toEqual([]);
  });

  test('a read that lost its choices is treated as a half-drawn frame', async () => {
    const { sock } = await blockedOnFirstQuestion();
    glassesRelayDeps.readPaneText = async () => 'Which approach should I take?';
    await trackGlassesRelay();
    expect(sock.messages).toEqual([]);
  });

  test('a different question with no readable choices still replaces the item', async () => {
    // The half-drawn-frame guard held on the question text as well as the
    // options, and a pane that had genuinely moved on to something this scrape
    // cannot parse was left showing the previous question's options. Offering
    // the right question with nothing under it beats offering the wrong
    // question's answers.
    const { sock, itemId } = await blockedOnFirstQuestion();
    glassesRelayDeps.readPaneText = async () => 'Which branch should I use?';
    await trackGlassesRelay();

    expect(sock.ofType('glasses-relay-remove').map((m) => m.id)).toContain(itemId);
    const item = sock.ofType('glasses-relay')[0].item as Record<string, unknown>;
    expect(item.text).toBe('Which branch should I use?');
    expect(item.choices).toBeUndefined();
  });

  test('a pane that stopped asking keeps what is on the glasses', async () => {
    // Only `exitBlocked` takes an item down. A redraw that no longer shows a
    // question - the wearer answered at the keyboard, and the pane has not
    // unblocked yet - must not blank the panel mid-glance.
    const { sock } = await blockedOnFirstQuestion();
    glassesRelayDeps.readPaneText = async () => '  ⏵⏵ auto mode on (shift+tab to cycle)';
    await trackGlassesRelay();
    expect(sock.messages).toEqual([]);
  });

  test('a dismissed item is not re-raised by a redraw', async () => {
    const { sock, itemId } = await blockedOnFirstQuestion();
    dismissRelayItem(itemId);
    sock.messages = [];

    glassesRelayDeps.readPaneText = async () => SECOND_QUESTION;
    await trackGlassesRelay();

    expect(sock.ofType('glasses-relay')).toEqual([]);
  });

  test('presence gate: no subscriber, no scrape', async () => {
    let scrapes = 0;
    glassesRelayDeps.readPaneText = async () => {
      scrapes++;
      return QUESTION_PANE;
    };
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'working' }])];
    await trackGlassesRelay();
    glassesRelayDeps.listWorkspaces = async () => [ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }])];
    await trackGlassesRelay();
    await trackGlassesRelay();
    expect(scrapes).toBe(0);
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

// =============================================================================
// Hook notifications routed to the glasses
// =============================================================================

/** Workspace stub carrying the fields the hook resolver joins on. */
function hookWs(
  id: string,
  panes: Array<{ paneId: string; agentSessionId?: string; path?: string; agent?: string }>,
  agentSessionId?: string,
): WorkspaceInfo {
  return {
    id,
    name: id,
    instanceId: `w-${id}`,
    createdAt: '',
    attached: false,
    agentSessionId,
    panes: panes.map((p) => ({
      paneId: p.paneId,
      command: 'claude',
      path: p.path ?? `/tmp/${id}`,
      agent: 'agent' in p ? p.agent : 'claude',
      agentSessionId: p.agentSessionId,
      isActive: true,
    })),
  } as unknown as WorkspaceInfo;
}

describe('resolveHookTarget', () => {
  test('joins on the pane agent session id, naming the exact reply target', async () => {
    glassesRelayDeps.listWorkspaces = async () => [
      hookWs('other', [{ paneId: '%0', agentSessionId: 'uuid-other' }]),
      hookWs('dev', [
        { paneId: '%0', agentSessionId: 'uuid-a' },
        { paneId: '%1', agentSessionId: 'uuid-b' },
      ]),
    ];
    expect(await resolveHookTarget('uuid-b', undefined)).toEqual({ sessionId: 'dev', paneId: '%1' });
  });

  test('a pane match beats a workspace-level match found earlier in the list', async () => {
    glassesRelayDeps.listWorkspaces = async () => [
      hookWs('ws-level', [{ paneId: '%0' }], 'uuid-a'),
      hookWs('pane-level', [{ paneId: '%3', agentSessionId: 'uuid-a' }]),
    ];
    expect(await resolveHookTarget('uuid-a', undefined)).toEqual({
      sessionId: 'pane-level',
      paneId: '%3',
    });
  });

  test('falls back to the workspace session id when no pane carries one', async () => {
    glassesRelayDeps.listWorkspaces = async () => [hookWs('dev', [{ paneId: '%0' }], 'uuid-a')];
    expect(await resolveHookTarget('uuid-a', undefined)).toEqual({ sessionId: 'dev' });
  });

  test('falls back to cwd when the hook carries no session id', async () => {
    glassesRelayDeps.listWorkspaces = async () => [
      hookWs('dev', [{ paneId: '%0', path: '/home/u/app' }]),
      hookWs('docs', [{ paneId: '%0', path: '/home/u/docs' }]),
    ];
    expect(await resolveHookTarget(undefined, '/home/u/docs')).toEqual({
      sessionId: 'docs',
      paneId: '%0',
    });
  });

  test('two agents in one directory keep the workspace but lose the pane', async () => {
    glassesRelayDeps.listWorkspaces = async () => [
      hookWs('dev', [
        { paneId: '%0', path: '/home/u/app' },
        { paneId: '%1', path: '/home/u/app' },
      ]),
    ];
    expect(await resolveHookTarget(undefined, '/home/u/app')).toEqual({ sessionId: 'dev' });
  });

  test('the same directory in two workspaces resolves to nothing', async () => {
    glassesRelayDeps.listWorkspaces = async () => [
      hookWs('a', [{ paneId: '%0', path: '/home/u/app' }]),
      hookWs('b', [{ paneId: '%0', path: '/home/u/app' }]),
    ];
    expect(await resolveHookTarget(undefined, '/home/u/app')).toBeNull();
  });

  test('a pane running no agent is not a cwd match', async () => {
    glassesRelayDeps.listWorkspaces = async () => [
      hookWs('dev', [{ paneId: '%0', path: '/home/u/app', agent: undefined }]),
    ];
    expect(await resolveHookTarget(undefined, '/home/u/app')).toBeNull();
  });

  test('an unknown session and an unknown directory resolve to nothing', async () => {
    glassesRelayDeps.listWorkspaces = async () => [hookWs('dev', [{ paneId: '%0' }])];
    expect(await resolveHookTarget('uuid-missing', '/nowhere')).toBeNull();
  });
});

describe('postHookRelay', () => {
  test('without a subscriber it delivers nothing and reports so', () => {
    expect(postHookRelay({ sessionId: 's1', text: 'Response complete' })).toBe(false);
  });

  test('delivers an info item that expires far sooner than an agent note', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sock);
    sock.messages = [];

    expect(postHookRelay({ sessionId: 's1', paneId: '%1', text: 'Response complete' })).toBe(true);
    const upserts = sock.ofType('glasses-relay');
    expect(upserts).toHaveLength(1);
    const item = upserts[0].item as { kind: string; paneId: string; text: string; expiresAt: number };
    expect(item.kind).toBe('info');
    expect(item.paneId).toBe('%1');
    expect(item.text).toBe('Response complete');
    // Notification-lifetime, not the 5-minute agent-note lifetime.
    expect(item.expiresAt - Date.now()).toBeLessThanOrEqual(90_000);
    expect(item.expiresAt - Date.now()).toBeGreaterThan(60_000);
  });

  test('an unanswered question already covers the session: no second item, still suppressed', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sock);
    postAgentRelay({ sessionId: 's1', kind: 'waiting', text: 'Which one?' });
    sock.messages = [];

    expect(postHookRelay({ sessionId: 's1', text: 'Waiting for your input' })).toBe(true);
    expect(sock.ofType('glasses-relay')).toHaveLength(0);
  });

  test('a dismissed question does not cover the session', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sock);
    const waiting = mustItem(postAgentRelay({ sessionId: 's1', kind: 'waiting', text: 'Which one?' }));
    dismissRelayItem(waiting.id);
    sock.messages = [];

    expect(postHookRelay({ sessionId: 's1', text: 'Response complete' })).toBe(true);
    expect(sock.ofType('glasses-relay')).toHaveLength(1);
  });

  test('the latest notification replaces the previous one for that session', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sock);
    postHookRelay({ sessionId: 's1', text: 'first' });
    const firstId = (sock.ofType('glasses-relay')[0].item as { id: string }).id;
    sock.messages = [];

    postHookRelay({ sessionId: 's1', text: 'second' });
    expect((sock.ofType('glasses-relay')[0].item as { text: string }).text).toBe('second');
    expect(sock.ofType('glasses-relay-remove').map((m) => m.id)).toEqual([firstId]);
  });

  test('a rate-limited session reports undelivered, so the browser notifies instead', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sock);
    for (let i = 0; i < 12; i++) {
      expect(postHookRelay({ sessionId: 'flood', text: `n${i}` })).toBe(true);
    }
    expect(postHookRelay({ sessionId: 'flood', text: 'too much' })).toBe(false);
  });

  test('the real question replaces a hook notification, but not an agent note', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => QUESTION_PANE;
    // s2 stays in the list: a workspace that vanishes has its items dropped
    // wholesale, which would mask what this test is about.
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'working' }]),
      ws('s2', [{ paneId: '%0', agentStatus: 'working' }]),
    ];
    await subscribeGlassesRelay(sock);
    await trackGlassesRelay(); // baseline

    postHookRelay({ sessionId: 's1', text: 'Waiting for your input' });
    const hookInfoId = (sock.ofType('glasses-relay')[0].item as { id: string }).id;
    const agentNote = mustItem(postAgentRelay({ sessionId: 's2', kind: 'info', text: 'agent note' }));
    sock.messages = [];

    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }]),
      ws('s2', [{ paneId: '%0', agentStatus: 'working' }]),
    ];
    await trackGlassesRelay();

    expect(sock.ofType('glasses-relay-remove').map((m) => m.id)).toEqual([hookInfoId]);
    const snapshot = await buildGlassesRelaySnapshot();
    expect(snapshot.map((i) => i.id)).toContain(agentNote.id);
  });
});

describe('simulator vs device', () => {
  test('a simulator sees the notification but does not silence the browser', async () => {
    const sim = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sim, false);
    sim.messages = [];

    // Undelivered as far as the browser is concerned...
    expect(postHookRelay({ sessionId: 's1', text: 'Response complete' })).toBe(false);
    // ...but the panel it previews still shows what the panel would show.
    expect(sim.ofType('glasses-relay')).toHaveLength(1);
  });

  test('a device alongside a simulator still silences the browser', async () => {
    const sim = new FakeSocket();
    const dev = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sim, false);
    await subscribeGlassesRelay(dev, true);

    expect(postHookRelay({ sessionId: 's1', text: 'Response complete' })).toBe(true);
    expect(sim.ofType('glasses-relay')).toHaveLength(1);
    expect(dev.ofType('glasses-relay')).toHaveLength(1);
  });

  test('an omitted flag counts as a device, so a pre-flag ehpk keeps working', async () => {
    const old = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(old);
    expect(postHookRelay({ sessionId: 's1', text: 'Response complete' })).toBe(true);
  });

  test('an unanswered question suppresses only when a device is watching', async () => {
    const sim = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sim, false);
    postAgentRelay({ sessionId: 's1', kind: 'waiting', text: 'Which one?' });

    expect(postHookRelay({ sessionId: 's1', text: 'Waiting for your input' })).toBe(false);
  });

  test('a device that disconnects stops counting', async () => {
    const dev = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(dev, true);
    expect(glassesDeviceCount()).toBe(1);
    unsubscribeGlassesRelay(dev);
    expect(glassesDeviceCount()).toBe(0);
    expect(postHookRelay({ sessionId: 's1', text: 'Response complete' })).toBe(false);
  });

  test('resubscribing as a simulator drops the device claim', async () => {
    // The socket is reused across a reconnect; a stale device claim would keep
    // the browser silent for a tab that is only previewing.
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [];
    await subscribeGlassesRelay(sock, true);
    await subscribeGlassesRelay(sock, false);
    expect(glassesDeviceCount()).toBe(0);
  });
})

// =============================================================================
// opencode: a rule down the left, and options side by side
// =============================================================================

describe('a pane that frames itself with a rule', () => {
  test('the framing is not part of what a line says', () => {
    // The rule goes; the content's own indentation is not the rule's to take.
    expect(stripLeftRule('  ┃  1. Yes')).toBe('  1. Yes');
    expect(stripLeftRule('│ [ ] Apple')).toBe(' [ ] Apple');
    expect(stripLeftRule('  2. plain')).toBe('  2. plain');
  });

  test('a numbered list inside a frame is read like any other', () => {
    // No agent draws this today. It is here because the frame was enough on its
    // own to hide a list from every reader in this file, and the next agent to
    // draw a box round its prompt should not rediscover that.
    expect(extractNumberedChoices(['┃ Which one?', '┃ ❯ 1. Yes', '┃   2. No'])).toEqual([
      'Yes',
      'No',
    ]);
  });

  test('the question is never the frame itself', () => {
    // What a wearer actually got: a notification reading `┃`. The prompt ends
    // in no question mark and says no `Do you want to`, so the fallback took
    // the last non-empty line, and on this pane that is a box-drawing glyph.
    expect(extractQuestionLine(OPENCODE_PANE.split('\n'))).not.toBe('┃');
    expect(extractQuestionLine(['│', '│  something happened', '│', '│'])).toBe(
      'something happened',
    );
  });

  test('the two halves of a permission prompt are one question', () => {
    // Separately they are useless: the first says only that permission is
    // wanted, the second only names the file.
    expect(extractPermissionRequest(OPENCODE_PANE.split('\n'))).toBe(
      'Permission required: Edit fixture.txt',
    );
  });

  test('a heading brings the line under it, because that is the decision', () => {
    // Captured from the same live pane asking to run a command. `Shell
    // command` on its own tells a wearer that something wants running and not
    // what, which is the entire thing being decided.
    expect(
      extractPermissionRequest([
        '  \u2503  \u25b3 Permission required',
        '  \u2503    # Shell command',
        '  \u2503',
        '  \u2503  $ echo second',
      ]),
    ).toBe('Permission required: Shell command: echo second');
  });

  test('a subject that is already the thing stands alone', () => {
    expect(
      extractPermissionRequest([
        '  \u2503  \u25b3 Permission required',
        '  \u2503    \u2192 Edit fixture.txt',
        '  \u2503',
        '  \u2503  1 + fixture',
      ]),
    ).toBe('Permission required: Edit fixture.txt');
  });

  test('the option row below is never mistaken for the subject', () => {
    // It is made of words and sits on the same pane, so the window that looks
    // for a subject has to end before it does.
    const text = extractPermissionRequest([
      '  \u2503  \u25b3 Permission required',
      '  \u2503',
      '  \u2503',
      '  \u2503',
      '  \u2503',
      '  \u2503   Allow once   Allow always   Reject',
    ]);
    expect(text).toBe('Permission required');
  });

  test('a pane with no permission line is left to the ordinary reader', () => {
    expect(extractPermissionRequest(['Continue?', '1. Yes'])).toBeUndefined();
  });
});

describe('opencode reaches the glasses', () => {
  async function blockedOnOpencode(): Promise<FakeSocket> {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => OPENCODE_PANE;
    glassesRelayDeps.readPaneAnsi = async () => OPENCODE_PANE_ANSI;
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'working' }]),
    ];
    await subscribeGlassesRelay(sock);
    await trackGlassesRelay();
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }]),
    ];
    sock.messages = [];
    await trackGlassesRelay();
    return sock;
  }

  test('the waiting item carries the question, the options and where the pane is', async () => {
    const sock = await blockedOnOpencode();
    const item = sock.ofType('glasses-relay')[0].item as Record<string, unknown>;
    expect(item.text).toBe('Permission required: Edit fixture.txt');
    // The key hints share the options row on a pane this wide; offering
    // `enter confirm` as an answer would walk the pane onto a real option and
    // press Enter on it.
    expect(item.choices).toEqual(['Allow once', 'Allow always', 'Reject']);
    expect(item.choiceInput).toBe('arrow');
    expect(item.choiceSelected).toBe(0);
  });

  test('the coloured read is spent only where the plain one found nothing', async () => {
    let coloured = 0;
    glassesRelayDeps.readPaneText = async () => QUESTION_PANE;
    glassesRelayDeps.readPaneAnsi = async () => {
      coloured++;
      return OPENCODE_PANE_ANSI;
    };
    const sock = new FakeSocket();
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'working' }]),
    ];
    await subscribeGlassesRelay(sock);
    await trackGlassesRelay();
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }]),
    ];
    await trackGlassesRelay();
    // A claude pane offers a numbered list, so the second round trip is never
    // taken and every agent that already worked keeps the read it had.
    expect(coloured).toBe(0);
  });

  test('a selection that moved is an edit, not another question', () => {
    // Someone at the keyboard can walk the pane's cursor without a word of the
    // question changing. That index is where the glasses' own walk starts, so a
    // stale one sends the right number of steps from the wrong place, and the
    // wearer confirms an option they did not pick.
    //
    // Built rather than captured: the capture has the highlight on `Allow
    // once`, and the case under test is the same row with it somewhere else.
    const bg = (colour: string, text: string) => `\x1b[48;2;${colour}m${text}\x1b[0m`;
    const ROW = '30;30;30';
    const HIT = '245;167;66';
    const row = (selected: number) =>
      bg(ROW, '  \u2503   ') +
      ['Allow once', 'Allow always', 'Reject']
        .map((o, i) => bg(i === selected ? HIT : ROW, o))
        .join(bg(ROW, '   ')) +
      bg(ROW, ' '.repeat(30));
    const paneWith = (selected: number) =>
      ['  \u2503  \u25b3 Permission required', '  \u2503    \u2192 Edit fixture.txt', row(selected)].join(
        '\n',
      );

    return (async () => {
      const sock = new FakeSocket();
      glassesRelayDeps.readPaneText = async () => OPENCODE_PANE;
      glassesRelayDeps.readPaneAnsi = async () => paneWith(0);
      glassesRelayDeps.listWorkspaces = async () => [
        ws('s1', [{ paneId: '%0', agentStatus: 'working' }]),
      ];
      await subscribeGlassesRelay(sock);
      await trackGlassesRelay();
      glassesRelayDeps.listWorkspaces = async () => [
        ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }]),
      ];
      await trackGlassesRelay();
      const first = sock.ofType('glasses-relay')[0].item as Record<string, unknown>;
      expect(first.choiceSelected).toBe(0);
      sock.messages = [];

      glassesRelayDeps.readPaneAnsi = async () => paneWith(2);
      await trackGlassesRelay();

      const next = sock.ofType('glasses-relay')[0].item as Record<string, unknown>;
      // The SAME id. A moved cursor is an edit to the question on screen, not
      // another question - and this file used to mint a new id for it, which on
      // a pane that redraws as often as opencode's produced seven identical
      // permission prompts inside 1.3 seconds. Answering one only uncovered
      // the next; the wearer could not get past them.
      expect(next.id).toBe(first.id);
      expect(next.text).toBe(first.text);
      expect(next.choices).toEqual(first.choices);
      expect(next.choiceSelected).toBe(2);
      // Nothing is taken down either: a remove and a fresh upsert is how the
      // client is told to treat it as new.
      expect(sock.ofType('glasses-relay-remove')).toEqual([]);
    })();
  });
});

// =============================================================================
// The question is above the options, not at the bottom of the pane
// =============================================================================

describe('finding the question without a question mark', () => {
  /**
   * Captured from a live Claude Code pane on 2026-08-07, in Japanese, with the
   * wearer part-way through typing their next message. What reached the glasses
   * was `❯ ちなみに録画情報を見てください` — the line THEY had just typed,
   * presented to them as the agent's question.
   */
  const JAPANESE_ASK = [
    '● 今この場で出します。',
    '────────────────────────────',
    '←  ☐ 複数選択  ✔ Submit  →',
    '',
    '（検証用）好きな果物を選んでください（複数可）',
    '',
    '❯ 1. [ ] りんご',
    '  2. [ ] みかん',
    '  3. [ ] ぶどう',
    '  4. [ ] Type something',
    '────────────────────────────',
    '❯ ちなみに録画情報を見てください',
    '────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ];

  test('a Japanese question that ends in no question mark is still the question', () => {
    expect(extractQuestionLine(JAPANESE_ASK, optionBlockStart(JAPANESE_ASK))).toBe(
      '（検証用）好きな果物を選んでください（複数可）',
    );
  });

  test("what the wearer is typing is never the agent's question", () => {
    const text = extractQuestionLine(JAPANESE_ASK, optionBlockStart(JAPANESE_ASK));
    expect(text).not.toContain('ちなみに録画情報');
    expect(text).not.toContain('auto mode on');
  });

  test('a full-width question mark counts as one', () => {
    expect(extractQuestionLine(['前置き', 'どちらにしますか？', 'あとがき'])).toBe(
      'どちらにしますか？',
    );
  });

  test('the option block is found by either shape', () => {
    expect(optionBlockStart(['Which?', '❯ 1. Yes', '  2. No'])).toBe(1);
    expect(optionBlockStart(['Which?', '   [ ] Apple', '   [ ] Banana'])).toBe(1);
    expect(optionBlockStart(['no options here', 'at all'])).toBe(2);
  });

  test('a pane with no options still answers from the whole pane', () => {
    // The window is the whole pane when there is no option block, so nothing
    // that worked before this stops working.
    expect(extractQuestionLine(['noise', 'Continue?', 'more noise'])).toBe('Continue?');
  });
});

// =============================================================================
// Blocked is not the same as asking
// =============================================================================

describe('a pane blocked without a question', () => {
  /**
   * What claude looks like between turns: herdr calls the pane `blocked`, and
   * the bottom of the screen is its own status bar. On 2026-08-07 that reached
   * a wearer as `⏵⏵ auto mode on (shift+tab to cycle)` under a `[!] WAITING`
   * header, and it could not be got rid of - a waiting item claims double-tap
   * on the conversation screen, so "back" became "later", and the next blocked
   * flicker made another one. The wearer could not leave the screen.
   */
  const IDLE_PANE = [
    '● 環境を撤収しました。',
    '────────────────────────────',
    '❯ ',
    '────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');

  async function blockOn(pane: string): Promise<FakeSocket> {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => pane;
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'working' }]),
    ];
    await subscribeGlassesRelay(sock);
    await trackGlassesRelay();
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }]),
    ];
    sock.messages = [];
    await trackGlassesRelay();
    return sock;
  }

  test('produces no notification at all', async () => {
    const sock = await blockOn(IDLE_PANE);
    expect(sock.ofType('glasses-relay')).toEqual([]);
  });

  test('and none however many times it flickers', async () => {
    // Dismissing was no defence: each enter-blocked built a fresh, undismissed
    // item, so the notice came back within a tick every time.
    const sock = await blockOn(IDLE_PANE);
    for (let i = 0; i < 5; i++) {
      glassesRelayDeps.listWorkspaces = async () => [
        ws('s1', [{ paneId: '%0', agentStatus: 'working' }]),
      ];
      await trackGlassesRelay();
      glassesRelayDeps.listWorkspaces = async () => [
        ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }]),
      ];
      await trackGlassesRelay();
    }
    expect(sock.ofType('glasses-relay')).toEqual([]);
  });

  test('a real question on the same pane still gets through', async () => {
    const sock = await blockOn(['Which colour?', '❯ 1. Red', '  2. Green'].join('\n'));
    const item = sock.ofType('glasses-relay')[0].item as Record<string, unknown>;
    expect(item.text).toBe('Which colour?');
    expect(item.choices).toEqual(['Red', 'Green']);
  });

  test('so does a question with no options, when it reads as one', async () => {
    // Silence is for panes that are not asking, not for prompts this scrape
    // cannot list.
    const sock = await blockOn(['Paste the token, then press enter.', 'Which one?'].join('\n'));
    const item = sock.ofType('glasses-relay')[0].item as Record<string, unknown>;
    expect(item.text).toBe('Which one?');
  });
});

// =============================================================================
// A pane that was already blocked when it started asking
// =============================================================================

describe('a question that arrives without a transition', () => {
  /**
   * Reported from the device on 2026-08-07: the first question of a set never
   * reached the glasses, and the second one did. The pane was already
   * `blocked` before the question - it was holding queued input - so
   * `enterBlocked` never fired, and answering the first question is what
   * finally moved the status enough to build an item for the second.
   *
   * It used to be covered by accident: a blocked pane always produced SOME
   * item, even when that was the status bar read as a question, and the real
   * question replaced it when it came. Declining to build the junk took away
   * the thing the real one was arriving into.
   */
  test('is picked up while the pane stays blocked', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => '  ⏵⏵ auto mode on (shift+tab to cycle)';
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }]),
    ];
    await subscribeGlassesRelay(sock);
    // Baseline: blocked from the first look, with nothing being asked.
    await trackGlassesRelay();
    await trackGlassesRelay();
    expect(sock.ofType('glasses-relay')).toEqual([]);
    sock.messages = [];

    // Now it asks, and the status has nowhere left to move.
    glassesRelayDeps.readPaneText = async () =>
      ['どちらにしますか？', '❯ 1. うどん', '  2. そば'].join('\n');
    await trackGlassesRelay();

    const item = sock.ofType('glasses-relay')[0].item as Record<string, unknown>;
    expect(item.text).toBe('どちらにしますか？');
    expect(item.choices).toEqual(['うどん', 'そば']);
  });

  test('and a dismissed one is still not re-raised', async () => {
    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () =>
      ['どちらにしますか？', '❯ 1. うどん', '  2. そば'].join('\n');
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }]),
    ];
    await subscribeGlassesRelay(sock);
    await trackGlassesRelay();
    const id = (sock.ofType('glasses-relay')[0].item as Record<string, unknown>).id as string;
    dismissRelayItem(id);
    sock.messages = [];

    await trackGlassesRelay();
    await trackGlassesRelay();
    // "Later" was said about this pane; a tick is not a reason to ask again.
    expect(sock.ofType('glasses-relay').filter((m) => {
      const it = m.item as Record<string, unknown>;
      return it.dismissed !== true;
    })).toEqual([]);
  });
});

// =============================================================================
// codex: a third cursor glyph, and a question that wraps
// =============================================================================

describe('codex draws its cursor with a different glyph again', () => {
  /**
   * Captured from codex-cli 0.146.0 on 2026-08-07 - the trust prompt, which is
   * the first thing it shows and the worst one to get wrong: answering it
   * grants project-local config, hooks and exec policies.
   *
   * `›` is U+203A, and it was not in the cursor class. The cost was not the row
   * it marks going missing, it was the row going missing while its sibling
   * stayed: `2. No, quit` has no cursor, so it matched on its own. The glasses
   * were handed one option reading `No, quit`, and answering it types `1`.
   */
  const CODEX_TRUST = [
    '> You are in /tmp/codex-choice-test',
    '',
    '  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt',
    '  injection. Trusting the directory allows project-local config, hooks, and exec policies to load.',
    '',
    '› 1. Yes, continue',
    '  2. No, quit',
    '',
    '  Press enter to continue',
  ];

  test('both options are read, in the order the pane numbers them', () => {
    expect(extractNumberedChoices(CODEX_TRUST)).toEqual(['Yes, continue', 'No, quit']);
  });

  test('the cursor row is never the one that goes missing', () => {
    // The half-read is worse than the no-read: one option on the panel, and
    // the key that answers it belongs to the option that was dropped.
    const choices = extractNumberedChoices(CODEX_TRUST);
    expect(choices).not.toEqual(['No, quit']);
    expect(choices[0]).toBe('Yes, continue');
  });

  test('every cursor an agent has been seen to draw is accepted', () => {
    for (const cursor of ['❯', '›', '»', '→', '>', '*', '‣', '▸']) {
      expect(extractNumberedChoices([`${cursor} 1. Yes`, '  2. No'])).toEqual(['Yes', 'No']);
    }
  });

  test('a wrapped question is read whole, not by its last fragment', () => {
    const text = extractQuestionLine(CODEX_TRUST, optionBlockStart(CODEX_TRUST));
    expect(text).toContain('Do you trust the contents of this directory?');
    // The fragment that used to arrive on its own says nothing about what is
    // being decided.
    expect(text).not.toBe(
      'injection. Trusting the directory allows project-local config, hooks, and exec policies to load.',
    );
  });

  test('a question that fits on one line is still taken as one line', () => {
    // Only a wrapped one gets joined - an agent that could fit the question on
    // a line did, and gluing the line above it on would be inventing.
    expect(extractQuestionLine(['Some prose about the change.', 'Which one?', '❯ 1. A', '  2. B'], 2))
      .toBe('Which one?');
  });
});

describe('a pane that redraws does not mint questions', () => {
  /**
   * OpenCode's TUI redraws constantly, and the highlight reads slightly
   * differently across frames. Reported from the device on 2026-08-07: seven
   * identical permission prompts inside 1.3 seconds, each with an id of its
   * own, so answering the first only uncovered the second and the wearer could
   * not get past them.
   */
  test('many redraws of one question stay one question', async () => {
    const bg = (colour: string, text: string) => `\x1b[48;2;${colour}m${text}\x1b[0m`;
    const ROW = '30;30;30';
    const HIT = '245;167;66';
    const row = (selected: number) =>
      bg(ROW, '  ┃   ') +
      ['Allow once', 'Allow always', 'Reject']
        .map((o, i) => bg(i === selected ? HIT : ROW, o))
        .join(bg(ROW, '   ')) +
      bg(ROW, ' '.repeat(30));
    const pane = (selected: number) =>
      ['  ┃  △ Permission required', '  ┃    → Edit x.txt', row(selected)].join('\n');

    const sock = new FakeSocket();
    glassesRelayDeps.readPaneText = async () => OPENCODE_PANE;
    let frame = 0;
    glassesRelayDeps.readPaneAnsi = async () => pane(frame++ % 3);
    glassesRelayDeps.listWorkspaces = async () => [
      ws('s1', [{ paneId: '%0', agentStatus: 'blocked' }]),
    ];
    await subscribeGlassesRelay(sock);
    await trackGlassesRelay();
    const first = sock.ofType('glasses-relay')[0].item as Record<string, unknown>;

    // Ten more passes, the highlight landing somewhere different each time.
    for (let i = 0; i < 10; i++) await trackGlassesRelay();

    const ids = new Set(sock.ofType('glasses-relay').map((m) => (m.item as Record<string, unknown>).id));
    expect(ids).toEqual(new Set([first.id]));
    expect(sock.ofType('glasses-relay-remove')).toEqual([]);
  });
});
