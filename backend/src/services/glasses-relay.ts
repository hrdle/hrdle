/**
 * Glasses relay service (#504) — the "tell the user only what they need to
 * decide" channel for the G2 glasses.
 *
 * Three responsibilities:
 *   1. Store: one `waiting` + one `info` slot per session. waiting items live
 *      for a blocked epoch (enter-blocked creates, exit-blocked deletes,
 *      dismiss only flags); info items are agent self-reports with a TTL.
 *   2. Tracker: diffs per-pane herdr `agent_status` snapshots and turns
 *      `*→blocked` transitions into waiting items. Assembly (pane scrape) and
 *      sending happen ONLY while at least one glasses client is subscribed —
 *      the presence gate. Status tracking itself rides on the existing
 *      sessions pipeline events, so it costs nothing extra.
 *   3. Delivery: pushes `glasses-relay` / `glasses-relay-remove` /
 *      `glasses-relay-snapshot` to subscribed mux connections only.
 */

import { randomUUID } from 'node:crypto';
import type { GlassesRelayItem } from '../../../shared/types';
import { HerdrService, type WorkspaceInfo } from './herdr';
import { readPaneText, toHerdrPaneId } from './herdr-client';

// =============================================================================
// Tunables / defenses (unauthenticated local endpoint — see routes)
// =============================================================================

/** Cap on sessions held in the store; oldest evicted beyond this (#254 pattern). */
const MAX_STORE_SESSIONS = 200;
/** One G2 page ≈ 364 display columns, but a full page of question text is
 *  already unreadable in practice (#504 real-device feedback): the question
 *  must share the page with the choice list and still be glanceable. */
const MAX_TEXT_WIDTH = 120;
const MAX_CHOICES = 9;
const MAX_CHOICE_WIDTH = 52;
const INFO_TTL_MS = 5 * 60_000;
/**
 * Hook-sourced info items expire far sooner than agent self-notes.
 *
 * An agent's `cchub glasses` note is something it chose to say and wants read;
 * a hook notification is the glasses' answer to a browser push, and a push
 * that is still on screen five minutes later has stopped being news. Long
 * enough to catch on the next glance, short enough to clear itself.
 */
const HOOK_INFO_TTL_MS = 90_000;
/** Per-session POST rate limit (CLI self-notes). */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12;

// =============================================================================
// Display-width helpers (CJK-aware clamp so mixed Japanese/English never
// overflows the G2 page)
// =============================================================================

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return w;
}

/** Clamp to `max` display columns, appending `…` when truncated. */
export function clampDisplayWidth(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > max - 1) break; // reserve a column for …
    out += ch;
    w += cw;
  }
  return `${out.trimEnd()}…`;
}

/** Relay text is single-paragraph: collapse all whitespace runs to one space. */
export function normalizeRelayText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// =============================================================================
// Store
// =============================================================================

interface RelaySlot {
  waiting?: GlassesRelayItem;
  info?: GlassesRelayItem;
}

const store = new Map<string, RelaySlot>();

function evictStoreIfNeeded(): void {
  while (store.size > MAX_STORE_SESSIONS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function getSlot(sessionId: string): RelaySlot {
  let slot = store.get(sessionId);
  if (!slot) {
    slot = {};
    store.set(sessionId, slot);
  }
  // Refresh LRU position.
  store.delete(sessionId);
  store.set(sessionId, slot);
  return slot;
}

// Per-session POST rate limit (sliding window of timestamps).
const postLog = new Map<string, number[]>();

function checkRateLimit(sessionId: string): boolean {
  const now = Date.now();
  const log = (postLog.get(sessionId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (log.length >= RATE_LIMIT_MAX) {
    postLog.set(sessionId, log);
    return false;
  }
  log.push(now);
  postLog.set(sessionId, log);
  return true;
}

// =============================================================================
// Subscribers (presence gate) + delivery
// =============================================================================

/** Minimal structural type so tests can pass a fake socket. */
export interface RelaySocket {
  send(data: string): unknown;
}

const subscribers = new Set<RelaySocket>();

/**
 * Subscribers running on real glasses, as opposed to the browser simulator.
 *
 * Everything the device sees, the simulator sees — showing the panel is the
 * whole point of it. The difference is only in what a subscription is taken to
 * PROVE: a wearer has been told, so the browser push can stop; someone with a
 * simulator tab open has not, and silencing their notifications because a
 * preview window is up would lose them.
 */
const deviceSubscribers = new Set<RelaySocket>();

/**
 * Which run of the glasses app each device connection belongs to.
 *
 * The Even Realities app does not tear down a plugin's previous WebView when it
 * launches a new one — everything-evenhub#16 records two instances running
 * concurrently for over sixteen minutes, the stale one still holding the
 * microphone. From inside the WebView neither instance can see the other, and
 * the host offers nothing to ask. Both of them connect here, so this is the only
 * vantage point that has the answer.
 */
const deviceInstances = new WeakMap<RelaySocket, string>();

export function glassesRelaySubscriberCount(): number {
  return subscribers.size;
}

/** Subscribers that are actual hardware — the ones a notification reaches. */
export function glassesDeviceCount(): number {
  return deviceSubscribers.size;
}

/** What a departing subscription was, for a caller that wants to record it. */
export interface GlassesRelayDeparture {
  /** Real hardware rather than a simulator tab. */
  onDevice: boolean;
  /** The run id it subscribed with, absent on an ehpk older than the field. */
  instanceId?: string;
}

/**
 * Drop a subscription, and say what it was.
 *
 * The return value exists so a closing socket can be logged as the death of a
 * glasses run. Five of nineteen runs on 2026-07-31 died silently — the app's
 * heartbeat stopped, no `host exit` arrived, and nothing recorded the moment
 * they went. A quarter of the day's deaths were only found by reading the log
 * afterwards, and even then by inferring death from silence, which reads the
 * same as a log that is merely lagging.
 *
 * This side has the fact rather than the inference: the socket closed. It is
 * also the only observer left when the host kills a WebView too abruptly for
 * the app to say anything.
 *
 * Returns null when the socket was never a subscriber, so an ordinary browser
 * disconnect does not get reported as glasses going away.
 */
export function unsubscribeGlassesRelay(ws: RelaySocket): GlassesRelayDeparture | null {
  const wasSubscribed = subscribers.delete(ws);
  const onDevice = deviceSubscribers.delete(ws);
  const instanceId = deviceInstances.get(ws);
  deviceInstances.delete(ws);
  if (!wasSubscribed && !onDevice) return null;
  return { onDevice, ...(instanceId ? { instanceId } : {}) };
}

/**
 * Retire every device connection that belongs to an earlier run.
 *
 * Newest wins. That is the host's own rule as far as it can be observed: in both
 * recorded double launches the instance the host sent `launchSource` to — the one
 * it kept — was the one that started second.
 *
 * Only connections carrying a *different* instanceId are retired, so a socket
 * that drops and reconnects does not retire itself. Connections with no
 * instanceId are left alone: an ehpk older than the field cannot be told apart
 * from the newcomer, and silencing a live wearer on a guess is the worse error.
 *
 * The simulator never takes part. It subscribes with `onDevice: false`, so it is
 * neither retired by real glasses nor able to retire them — testing in a browser
 * while wearing the device has to keep working.
 */
function retirePreviousInstances(newcomer: RelaySocket, instanceId: string): void {
  const payload = JSON.stringify({ type: 'glasses-superseded', by: instanceId });
  for (const ws of deviceSubscribers) {
    if (ws === newcomer) continue;
    const previous = deviceInstances.get(ws);
    if (!previous || previous === instanceId) continue;
    console.log(`[glasses-relay] retiring instance ${previous}, superseded by ${instanceId}`);
    try {
      ws.send(payload);
    } catch {
      // Already gone, which is the outcome being asked for.
    }
    // Dropped from the device set immediately rather than waiting for it to
    // disconnect: while it is still counted, the server believes a wearer is
    // being shown notifications that are in fact going to a revoked panel.
    subscribers.delete(ws);
    deviceSubscribers.delete(ws);
    deviceInstances.delete(ws);
  }
}

function sendToSubscribers(msg: Record<string, unknown>): void {
  const payload = JSON.stringify(msg);
  for (const ws of subscribers) {
    try {
      ws.send(payload);
    } catch {
      subscribers.delete(ws);
      deviceSubscribers.delete(ws);
    }
  }
}

function broadcastUpsert(item: GlassesRelayItem): void {
  sendToSubscribers({ type: 'glasses-relay', item });
}

function broadcastRemove(id: string): void {
  sendToSubscribers({ type: 'glasses-relay-remove', id });
}

// =============================================================================
// Scrape assembly — "why is it waiting" from the pane itself
// =============================================================================

/**
 * One line of an option list, whoever drew it.
 *
 * Two numbering styles, because the agents do not agree: claude and codex
 * write `1. Yes`, kimi writes `[1] Yes`. The optional leading glyph is the
 * cursor on the selected row - `❯` from claude, `→` from kimi. herdr's
 * `strip_ansi` removes colour but leaves both characters alone, so they arrive
 * here as themselves.
 *
 * Kept in step with `extractChoices` in `glasses/src/ws-client.ts`, which is
 * the same reading done against a live terminal buffer.
 */
const NUMBERED_OPTION = /^\s*[❯>*→]?\s*(?:\d+[.)]|\[\d+\])\s*(.+)/;

/**
 * A checkbox row that carries no number at all.
 *
 * Kimi's multi-select draws exactly this - `   [ ] Apple`, four of them, and
 * not a digit anywhere on the screen even though `1-4` still works as a key.
 * `NUMBERED_OPTION` matched none of it, so a kimi multi-select produced no
 * choices at all; `refreshBlocked` then held the previous question rather than
 * replace it with an empty one, and the panel sat on question 1 while the pane
 * had moved to question 2. The wearer's next pick went to a question they were
 * never shown, which is the failure this whole path exists to prevent.
 *
 * Claude's multi-select rows are numbered *and* checkboxed (`1. [ ] Apple`),
 * so they match the numbered form first and keep their box in the capture -
 * the box is what tells the app this is a multi-select at all.
 */
const CHECKBOX_OPTION = /^\s*[❯>*→]?\s*(\[[ xX*✓✔]\]\s*\S.*)/;

/**
 * The rows a wearer cannot answer, whatever they are numbered.
 *
 * Every one of these opens free-text entry, and the ring has no keyboard - on
 * the glasses that is the voice flow, reached another way. Leaving them in
 * puts rows in the picker whose Enter does nothing a wearer can see.
 * `Other` is kimi's; the other two are claude's.
 */
const UNANSWERABLE = new Set(['Type something', 'Chat about this', 'Other']);

/**
 * Whether a captured row is one of those, once it is down to its label.
 *
 * Compared bare rather than literally, because the same row arrives in several
 * dresses: claude writes `Type something.` in a single-pick list and
 * `[ ] Type something` in a multi-select - no period, and a checkbox in front -
 * while kimi's `Other` becomes `[ ] Other:` the moment it is the row being
 * typed into. Matching the literal string caught the first and missed the rest,
 * so a picker carried rows whose only effect is to open a text field nobody
 * wearing the glasses can type into.
 */
function isUnanswerable(option: string): boolean {
  const bare = option
    .replace(/^\[[ xX*✓✔]\]\s*/, '')
    .trim()
    .replace(/[.:：]$/, '');
  return UNANSWERABLE.has(bare);
}

/** Extract `1. Yes` / `❯ 2. No` / `→ [1] Yes` / `[ ] Yes` style options. */
export function extractNumberedChoices(lines: string[]): string[] {
  const choices: string[] = [];
  for (const line of lines) {
    const m = line.match(NUMBERED_OPTION) ?? line.match(CHECKBOX_OPTION);
    if (m) choices.push(m[1].trim());
    if (choices.length >= MAX_CHOICES) break;
  }
  return choices.filter((c) => !isUnanswerable(c));
}

/**
 * The question the pane is waiting on: the last `?`-terminated line, or the
 * permission prompt's "Do you want to …" line. Falls back to the last
 * non-empty line (raw tail, unsummarized — display insurance only).
 */
export function extractQuestionLine(lines: string[]): string | undefined {
  const clean = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = clean.length - 1; i >= 0; i--) {
    if (/\?\s*$/.test(clean[i]) || /do you want to/i.test(clean[i])) return clean[i];
  }
  return clean[clean.length - 1];
}

async function assembleWaitingPayload(
  ws: WorkspaceInfo,
  tmuxPaneId: string,
): Promise<{ text: string; choices?: string[] }> {
  const fallback = `Waiting for input: ${ws.id}`;
  if (!ws.instanceId || !/^%[0-9A-Za-z]+$/.test(tmuxPaneId)) return { text: fallback };
  const herdrPaneId = toHerdrPaneId(ws.instanceId, tmuxPaneId);
  const raw = await glassesRelayDeps.readPaneText(herdrPaneId);
  if (!raw) return { text: fallback };

  const lines = raw.split('\n');
  const question = extractQuestionLine(lines);
  const text = clampDisplayWidth(normalizeRelayText(question ?? fallback), MAX_TEXT_WIDTH);
  const numbered = extractNumberedChoices(lines);
  const choices =
    numbered.length > 0
      ? numbered.map((c) => clampDisplayWidth(normalizeRelayText(c), MAX_CHOICE_WIDTH))
      : undefined;
  return { text: text || fallback, choices };
}

// =============================================================================
// Item lifecycle
// =============================================================================

function makeItem(
  sessionId: string,
  kind: GlassesRelayItem['kind'],
  source: GlassesRelayItem['source'],
  text: string,
  paneId?: string,
  choices?: string[],
  ttlMs: number = INFO_TTL_MS,
): GlassesRelayItem {
  const item: GlassesRelayItem = {
    id: randomUUID(),
    sessionId,
    kind,
    source,
    text: clampDisplayWidth(normalizeRelayText(text), MAX_TEXT_WIDTH) || '(empty)',
    createdAt: Date.now(),
  };
  if (paneId) item.paneId = paneId;
  if (choices && choices.length > 0) {
    item.choices = choices
      .slice(0, MAX_CHOICES)
      .map((c) => clampDisplayWidth(normalizeRelayText(c), MAX_CHOICE_WIDTH))
      .filter((c) => c.length > 0);
  }
  if (kind === 'info') item.expiresAt = Date.now() + ttlMs;
  return item;
}

/**
 * Agent self-note via `POST /api/glasses/relay` (the `cchub glasses` CLI).
 * waiting: at most one ACTIVE per session — a second one is rejected (409)
 * because unanswered decisions must not be silently replaced. info: latest
 * one per session wins, with a TTL.
 */
export function postAgentRelay(input: {
  sessionId: string;
  kind: GlassesRelayItem['kind'];
  text: string;
  paneId?: string;
  choices?: string[];
}): { status: number; item?: GlassesRelayItem; error?: string } {
  if (!checkRateLimit(input.sessionId)) {
    return { status: 429, error: 'rate limited' };
  }
  evictStoreIfNeeded();
  const slot = getSlot(input.sessionId);

  if (input.kind === 'waiting') {
    if (slot.waiting && !slot.waiting.dismissed) {
      return { status: 409, error: 'an active waiting item already exists', item: slot.waiting };
    }
    const item = makeItem(input.sessionId, 'waiting', 'agent', input.text, input.paneId, input.choices);
    slot.waiting = item;
    broadcastUpsert(item);
    return { status: 200, item };
  }

  const item = makeItem(input.sessionId, 'info', 'agent', input.text, input.paneId, input.choices);
  const replaced = slot.info;
  slot.info = item;
  broadcastUpsert(item);
  // Latest-one-per-session: drop the replaced info from subscriber queues too,
  // or a client keyed by item id would accumulate stale info items.
  if (replaced && replaced.id !== item.id) broadcastRemove(replaced.id);
  return { status: 200, item };
}

/**
 * Which workspace (and pane) a hook event belongs to.
 *
 * Hooks identify themselves by the agent's own session id — a Claude/Codex
 * conversation UUID — while relay items are keyed by workspace label, so the
 * two only meet through herdr. The session id is the exact join; `cwd` is the
 * fallback for hooks that carry no usable one, and it is trusted only when a
 * single agent claims that directory: two agents in one worktree make the pane
 * a coin flip, and a reply routed to the wrong pane is worse than no pane.
 */
export async function resolveHookTarget(
  agentSessionId: string | undefined,
  cwd: string | undefined,
): Promise<{ sessionId: string; paneId?: string } | null> {
  const workspaces = await glassesRelayDeps.listWorkspaces();

  if (agentSessionId) {
    // Panes first, across every workspace: a pane match names the exact reply
    // target, and settling for a workspace-level match found earlier in the
    // list would throw that away.
    for (const ws of workspaces) {
      const pane = ws.panes?.find((p) => p.agentSessionId === agentSessionId);
      if (pane) return { sessionId: ws.id, paneId: pane.paneId };
    }
    const ws = workspaces.find((w) => w.agentSessionId === agentSessionId);
    if (ws) return { sessionId: ws.id };
  }

  if (cwd) {
    const matches: { sessionId: string; paneId: string }[] = [];
    for (const ws of workspaces) {
      for (const pane of ws.panes ?? []) {
        if (pane.agent && pane.path === cwd) matches.push({ sessionId: ws.id, paneId: pane.paneId });
      }
    }
    if (matches.length === 1) return matches[0];
    // Ambiguous pane, unambiguous workspace: the notification still knows where
    // it came from, so keep the workspace and drop the pane.
    const ids = new Set(matches.map((m) => m.sessionId));
    if (ids.size === 1) return { sessionId: matches[0].sessionId };
  }

  return null;
}

/**
 * A Claude Code / Codex hook event, shown on the glasses instead of pushed to
 * the browser.
 *
 * Returns true only when the notification reached a face — a device
 * subscriber. The caller suppresses the browser push on exactly that.
 * Everything that can stop it from landing — no glasses, only a simulator
 * watching, rate limit — returns false and the push goes out as it always
 * did: a notification nobody sees is a worse failure than one seen twice.
 *
 * The item itself is still created and broadcast for a simulator-only
 * audience, because the simulator exists to show what the panel would show.
 */
export function postHookRelay(input: {
  sessionId: string;
  text: string;
  paneId?: string;
}): boolean {
  if (subscribers.size === 0) return false;
  const reachesAWearer = deviceSubscribers.size > 0;

  // An unanswered question already outranks anything a hook can say, and it is
  // on screen with its choices. "Response complete" underneath it would only
  // describe the same moment a second time, less usefully.
  const existing = store.get(input.sessionId);
  if (existing?.waiting && !existing.waiting.dismissed) return reachesAWearer;

  if (!checkRateLimit(input.sessionId)) return false;
  evictStoreIfNeeded();
  const slot = getSlot(input.sessionId);
  const item = makeItem(
    input.sessionId,
    'info',
    'auto',
    input.text,
    input.paneId,
    undefined,
    HOOK_INFO_TTL_MS,
  );
  const replaced = slot.info;
  slot.info = item;
  broadcastUpsert(item);
  // Latest-one-per-session, same as agent info notes: without this a client
  // keyed by item id accumulates every completion the session ever reported.
  if (replaced && replaced.id !== item.id) broadcastRemove(replaced.id);
  return reachesAWearer;
}

/** "Later / on PC": flag the item so snapshots skip it but the same blocked
 *  epoch is not re-synthesized on reconnect. herdr-side state is untouched —
 *  the PC UI keeps showing the session as waiting. */
export function dismissRelayItem(id: string): GlassesRelayItem | null {
  for (const slot of store.values()) {
    for (const item of [slot.waiting, slot.info]) {
      if (item?.id === id) {
        item.dismissed = true;
        broadcastUpsert(item);
        return item;
      }
    }
  }
  return null;
}

/** Sweep expired info items; returns removed ids (broadcasts each removal). */
function sweepExpiredInfo(): void {
  const now = Date.now();
  for (const [sessionId, slot] of store) {
    if (slot.info?.expiresAt !== undefined && slot.info.expiresAt <= now) {
      const id = slot.info.id;
      delete slot.info;
      if (!slot.waiting) store.delete(sessionId);
      broadcastRemove(id);
    }
  }
}

// =============================================================================
// Blocked-transition tracker
// =============================================================================

/** `${sessionId}/${paneId}` → last seen herdr agent_status. */
const paneStatus = new Map<string, string>();

function statusKey(sessionId: string, paneId: string): string {
  return `${sessionId}/${paneId}`;
}

async function enterBlocked(ws: WorkspaceInfo, paneId: string): Promise<void> {
  if (subscribers.size === 0) return; // presence gate: only track, never assemble
  const slot = getSlot(ws.id);
  if (slot.waiting && !slot.waiting.dismissed) return; // active waiting already covers this session
  // A dismissed item belongs to an older epoch (or another pane): this is a
  // fresh blocked transition, so it gets a fresh item.
  const { text, choices } = await assembleWaitingPayload(ws, paneId);
  const item = makeItem(ws.id, 'waiting', 'auto', text, paneId, choices);
  slot.waiting = item;
  broadcastUpsert(item);
  // A hook can report "waiting for input" a beat before herdr reports blocked,
  // leaving the session described twice — once vaguely, once with the actual
  // question. The real one wins. Only hook info is dropped (source 'auto');
  // an agent's own note is about something else and stays.
  if (slot.info?.source === 'auto') {
    const staleId = slot.info.id;
    delete slot.info;
    broadcastRemove(staleId);
  }
}

/**
 * A pane that never stopped being blocked, asking something else.
 *
 * One AskUserQuestion call can hold several questions: the TUI takes the
 * answer to the first and draws the second without the pane leaving
 * `blocked`, so no enter/exit transition fires and the item on the glasses
 * keeps the first question's text and options. The wearer's next pick then
 * lands on a question they were never shown - the worst of the two failure
 * modes, since it looks like it worked.
 *
 * A fresh item rather than an edit in place: this is a different decision, and
 * the id is what tells a client the difference.
 */
async function refreshBlocked(ws: WorkspaceInfo, paneId: string): Promise<void> {
  if (subscribers.size === 0) return; // presence gate, same as enterBlocked
  const slot = store.get(ws.id);
  const item = slot?.waiting;
  if (!slot || !item || item.source !== 'auto' || item.paneId !== paneId) return;
  // "Later / on PC" was said about this pane, and the wearer meant the pane
  // rather than the sentence. Re-raising it on every redraw would be arguing.
  if (item.dismissed) return;

  const { text, choices } = await assembleWaitingPayload(ws, paneId);
  const next = makeItem(ws.id, 'waiting', 'auto', text, paneId, choices);
  // A read that came back with no options while the last one had them is far
  // more likely a half-drawn frame than a question that lost its choices - but
  // only while it is still the same question. A read that lost the options AND
  // changed the question is a new question the scrape could not parse, and
  // holding the old one there means showing the wearer options belonging to a
  // question the pane has already moved past. Wrong question with no options
  // beats right-looking options for the wrong question.
  if (item.choices?.length && !next.choices?.length && next.text === item.text) return;
  if (next.text === item.text && sameChoices(item.choices, next.choices)) return;

  slot.waiting = next;
  broadcastRemove(item.id);
  broadcastUpsert(next);
}

function sameChoices(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * blocked→* on one pane. Removes the session's waiting item when it belongs
 * to this pane, then promotes another still-blocked pane of the same session
 * (multi-pane workspaces) so exactly one waiting item remains while anything
 * still waits.
 *
 * Only `auto` items follow the herdr blocked epoch. Agent self-notes
 * (source 'agent', posted via `cchub glasses`) have their own lifecycle —
 * answered→dismissed — and are NOT tied to any pane's blocked state, so an
 * unrelated pane unblocking must never drop them (#504). Auto items always
 * carry the blocked pane's id, so an exact paneId match is the right test.
 */
async function exitBlocked(ws: WorkspaceInfo, paneId: string): Promise<void> {
  const slot = store.get(ws.id);
  const item = slot?.waiting;
  if (item && item.source === 'auto' && item.paneId === paneId) {
    delete slot?.waiting;
    if (slot && !slot.info) store.delete(ws.id);
    broadcastRemove(item.id);
  }
  if (subscribers.size === 0 || store.get(ws.id)?.waiting) return;
  const other = ws.panes?.find((p) => p.agentStatus === 'blocked' && p.paneId !== paneId);
  if (other) await enterBlocked(ws, other.paneId);
}

/**
 * Diff the current workspace/pane statuses against the last snapshot and fire
 * enter/exit-blocked. Called from the sessions pipeline (agent-status watcher
 * events + the 5s tick), so a missed event self-heals on the next tick.
 */
export async function trackGlassesRelay(): Promise<void> {
  sweepExpiredInfo();
  const workspaces = await glassesRelayDeps.listWorkspaces();
  const seen = new Set<string>();

  for (const ws of workspaces) {
    for (const pane of ws.panes ?? []) {
      const key = statusKey(ws.id, pane.paneId);
      seen.add(key);
      const next = pane.agentStatus ?? 'unknown';
      const prev = paneStatus.get(key);
      if (prev === next) {
        // Still blocked is not "nothing happened": the question itself can
        // change under a pane that never unblocks (multi-step AskUserQuestion).
        if (next === 'blocked') await refreshBlocked(ws, pane.paneId);
        continue;
      }
      paneStatus.set(key, next);
      // Baseline (prev === undefined) never fires: panes already blocked when
      // tracking starts are covered by the subscribe-time snapshot instead.
      if (prev === undefined) continue;
      if (next === 'blocked') await enterBlocked(ws, pane.paneId);
      else if (prev === 'blocked') await exitBlocked(ws, pane.paneId);
    }
  }

  // Pane / workspace disappearance: treat a tracked-blocked pane as exited and
  // drop the session's relay state entirely when the workspace is gone.
  const workspaceIds = new Set(workspaces.map((w) => w.id));
  for (const key of [...paneStatus.keys()]) {
    if (seen.has(key)) continue;
    const [sessionId, paneId] = key.split('/');
    const wasBlocked = paneStatus.get(key) === 'blocked';
    paneStatus.delete(key);
    if (wasBlocked && workspaceIds.has(sessionId)) {
      const ws = workspaces.find((w) => w.id === sessionId);
      if (ws) await exitBlocked(ws, paneId);
    }
  }

  // Drop store items whose session is gone — including items a snapshot
  // synthesized before the tracker ever saw the session (they have no
  // paneStatus entry, so the loop above misses them). SKIPPED on an empty
  // list: listWorkspaces also returns [] when herdr is unreachable, and an
  // RPC blip must not wipe every pending decision.
  if (workspaces.length > 0) {
    for (const [sessionId, slot] of [...store.entries()]) {
      if (workspaceIds.has(sessionId)) continue;
      for (const item of [slot.waiting, slot.info]) {
        if (item) broadcastRemove(item.id);
      }
      store.delete(sessionId);
    }
  }
}

/**
 * Forget all tracked statuses. Called when the sessions pipeline stops (no
 * mux connections left); the next start re-baselines silently instead of
 * firing stale transitions.
 */
export function resetGlassesRelayTracker(): void {
  paneStatus.clear();
}

// =============================================================================
// Subscribe / snapshot
// =============================================================================

/**
 * Snapshot for a fresh subscriber: lazily assemble waiting items for panes
 * that are blocked RIGHT NOW but have no item yet, prune auto items whose
 * pane is no longer blocked (stale from a tracking gap), and return the
 * active set — waiting first, dismissed excluded.
 */
export async function buildGlassesRelaySnapshot(): Promise<GlassesRelayItem[]> {
  sweepExpiredInfo();
  const workspaces = await glassesRelayDeps.listWorkspaces();

  for (const ws of workspaces) {
    const slot = store.get(ws.id);
    const blockedPane = ws.panes?.find((p) => p.agentStatus === 'blocked');

    // Prune a stale auto item whose blocked epoch ended while tracking was off.
    if (slot?.waiting && slot.waiting.source === 'auto') {
      const stillBlocked = ws.panes?.some(
        (p) => p.agentStatus === 'blocked' && (!slot.waiting?.paneId || p.paneId === slot.waiting.paneId),
      );
      if (!stillBlocked) {
        const id = slot.waiting.id;
        delete slot.waiting;
        if (!slot.info) store.delete(ws.id);
        broadcastRemove(id);
      }
    }

    // Synthesize for a blocked pane with no item at all (covers pre-existing
    // blocked panes the tracker baseline-skipped). A dismissed item suppresses
    // re-synthesis for the same epoch.
    if (!store.get(ws.id)?.waiting && blockedPane) {
      await enterBlocked(ws, blockedPane.paneId);
    }
  }

  const items: GlassesRelayItem[] = [];
  for (const slot of store.values()) {
    if (slot.waiting && !slot.waiting.dismissed) items.push(slot.waiting);
    if (slot.info && !slot.info.dismissed) items.push(slot.info);
  }
  items.sort((a, b) => {
    const rank = (i: GlassesRelayItem) => (i.kind === 'waiting' ? 0 : 1);
    return rank(a) - rank(b) || a.createdAt - b.createdAt;
  });
  return items;
}

/**
 * Register a mux connection as a glasses relay subscriber and push the
 * snapshot. `onDevice` false marks a simulator: it still receives everything,
 * it just does not count as the user having been told.
 */
export async function subscribeGlassesRelay(
  ws: RelaySocket,
  onDevice = true,
  instanceId?: string,
): Promise<void> {
  subscribers.add(ws);
  if (onDevice) {
    deviceSubscribers.add(ws);
    if (instanceId) {
      deviceInstances.set(ws, instanceId);
      retirePreviousInstances(ws, instanceId);
    }
  } else {
    deviceSubscribers.delete(ws);
  }
  try {
    const items = await buildGlassesRelaySnapshot();
    ws.send(JSON.stringify({ type: 'glasses-relay-snapshot', items }));
  } catch (err) {
    console.warn('[glasses-relay] snapshot failed:', err);
    try {
      ws.send(JSON.stringify({ type: 'glasses-relay-snapshot', items: [] }));
    } catch {
      subscribers.delete(ws);
    }
  }
}

// Own HerdrService instance (same pattern as terminal-mux.ts): its 2s
// listWorkspaces cache dedups the tracker bursts (status event + 5s tick).
const herdrService = new HerdrService();

/** Dependency seams — unit tests swap these so no herdr RPC fires. */
export const glassesRelayDeps = {
  listWorkspaces: (): Promise<WorkspaceInfo[]> => herdrService.listWorkspaces(),
  readPaneText: (herdrPaneId: string): Promise<string | null> =>
    readPaneText(herdrPaneId, 'recent', 30),
};

/** Test hook: wipe all module state. */
export function resetGlassesRelayForTest(): void {
  store.clear();
  postLog.clear();
  paneStatus.clear();
  subscribers.clear();
  deviceSubscribers.clear();
}
