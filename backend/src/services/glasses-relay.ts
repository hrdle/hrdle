/**
 * Glasses relay service — the "tell the user only what they need to
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
import { extractInlineChoices } from '../../../shared/inline-choices';
import type { AgentProvider, GlassesRelayItem } from '../../../shared/types';
import { type OpenQuestion, type QuestionsRead, readAgentQuestions } from './agent-question';
import { hasPaneReader, readerNeedsPaint, readPaneQuestion } from './pane-readers';
import type { PaneQuestion } from './pane-readers';
import {
  CJK_EDGE,
  CURSOR,
  dropSidePanel,
  isFreeText,
  joinWrapped,
  MAX_DETAIL_CHARS,
  stripCursor,
} from './pane-readers/shared';
import { HerdrService, type WorkspaceInfo } from './herdr';
import { detectPaneState } from './pane-state';
import { readPane, readPaneText, toHerdrPaneId } from './herdr-client';

// =============================================================================
// Tunables / defenses (unauthenticated local endpoint — see routes)
// =============================================================================

/** Cap on sessions held in the store; oldest evicted beyond this. */
const MAX_STORE_SESSIONS = 200;
/** One G2 page ≈ 364 display columns, but a full page of question text is
 *  already unreadable in practice on the device: the question
 *  must share the page with the choice list and still be glanceable. */
const MAX_TEXT_WIDTH = 120;
const MAX_CHOICES = 9;
/** A choice row is one line of the picker, and the panel cuts what overruns it.
 *  The label alone, since the description travels beside it now. */
const MAX_CHOICE_WIDTH = 52;
/**
 * How much of a choice's description to send.
 *
 * It used to be worked out from the number of options: the picker drew the
 * whole list and then one description under it, so what a description could
 * have was the panel's eight lines less a row for each option. Six options and
 * a Send row leave nothing, and the arithmetic said so - the descriptions were
 * dropped here, before they were sent, and the wearer of a six-option question
 * saw six labels and no reason to prefer any of them. Reported off the device
 * on 2026-08-12: "ディスクリプションの表示内容が全部見えてなかった".
 *
 * The picker interleaves them now - label, description, label, description -
 * and scrolls, so the option under the ring gets the panel to itself whatever
 * the list's length. What a description is worth is therefore a property of
 * reading one off glasses rather than of how many there happen to be.
 *
 * Sent a little short of the space rather than a little over, deliberately.
 * Text cut here ends in an ellipsis the wearer can see; text cut by the app
 * ends by simply stopping, and a description that stops mid-thought while
 * looking finished is the more expensive of the two mistakes.
 */
const PANEL_LINES = 8;
/** Display columns per panel line, understated - see above. The panel fits
 *  about 24 full-width characters, which is 48 of these. */
const COLUMNS_PER_LINE = 46;
/** Its own label sits above it, and the row after it has to be reachable
 *  without the description having to be scrolled through first. */
const DETAIL_LINES = PANEL_LINES - 2;

function detailWidthFor(_optionRows: number): number {
  return DETAIL_LINES * COLUMNS_PER_LINE;
}

const INFO_TTL_MS = 5 * 60_000;
/**
 * Hook-sourced info items expire far sooner than agent self-notes.
 *
 * An agent's `hrdle glasses` note is something it chose to say and wants read;
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
 * cursor on the selected row, and every agent picked a different one - `❯` from
 * claude, `→` from kimi, `›` from codex. herdr's `strip_ansi` removes colour
 * but leaves all of them alone, so they arrive here as themselves.
 *
 * Missing one is not a missing row, it is a WRONG row. Measured against codex
 * 0.146.0 on 2026-08-07: its trust prompt draws `› 1. Yes, continue` over
 * `  2. No, quit`, and with `›` unlisted the first line failed to match while
 * the second, having no cursor, matched fine. The glasses were handed a single
 * option reading `No, quit` - and answering it types `1`, which is `Yes,
 * continue`. On the one prompt where the wrong answer grants project-local
 * config, hooks and exec policies.
 *
 * Kept in step with `extractChoices` in `glasses/src/ws-client.ts`, which is
 * the same reading done against a live terminal buffer.
 */
const NUMBERED_OPTION = new RegExp(`^\\s*${CURSOR}?\\s*(?:\\d+[.)]|\\[\\d+\\])\\s*(.+)`);

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
const CHECKBOX_OPTION = new RegExp(`^\\s*${CURSOR}?\\s*(\\[[ xX*✓✔]\\]\\s*\\S.*)`);



/**
 * The rule a pane frames its content with, on the left of every line.
 *
 * opencode draws one - `┃` down the whole prompt - and it was enough on its own
 * to make this file blind to that agent: every pattern here anchors at the
 * start of a line and allows only spaces and a cursor glyph before the thing it
 * is looking for. A rule is neither, so nothing matched, and it would have
 * matched nothing even if opencode had numbered its options.
 *
 * Stripped rather than allowed for in each pattern: a left border is furniture,
 * not content, and the readers should not each have to know that.
 */
const LEFT_RULE = /^(\s*[│┃|┆┊╎┇┋║])+/;

/** A line with its framing removed. */
export function stripLeftRule(line: string): string {
  return line.replace(LEFT_RULE, '');
}

/**
 * The line under an option that says what it means.
 *
 * Kimi's AskUserQuestion puts a bare label on the numbered line and the
 * substance under it, indented past where the label starts:
 *
 * ```
 *     [1] 案 A (Recommended)
 *         現行の動詞列の構成を活かしつつ「スマホやG2から」を明示
 * →   [2] 案 B
 *         最短。操作できることを先に言い切る
 * ```
 *
 * Reading only the numbered lines sent a wearer `案A / 案B / 案C` - three
 * labels that name nothing, on a question whose whole content was in the lines
 * that were dropped. Recorded on the G2 on 2026-08-08 and unanswerable as
 * drawn.
 *
 * Recognised by indentation rather than by what it says: a continuation is
 * indented further than the label it belongs to, which the footer hints
 * (`↑↓ select …`, flush left) and a blank separator line are not. The
 * indentation is measured against where the *label* starts, not the line, so
 * the cursor glyph on the selected row does not change the answer.
 */


/** Where the label starts within an option line, for the indent comparison. */
function labelColumn(line: string, label: string): number {
  const at = line.lastIndexOf(label);
  return at < 0 ? line.length : at;
}

/** Leading whitespace of a line, in characters. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** An option as the pane drew it: the row, and the lines under it that say
 *  what it means. Kept apart all the way to the item, because the picker draws
 *  them in different places. */
export interface ScrapedChoice {
  label: string;
  detail: string;
  /** The row opens a text field rather than answering. Kept, not dropped: the
   *  glasses answer it by dictation. */
  freeText?: boolean;
}


/** Extract `1. Yes` / `❯ 2. No` / `→ [1] Yes` / `[ ] Yes` style options, each
 *  with the description line under it when the agent draws one. */
export function extractChoiceRows(lines: string[]): ScrapedChoice[] {
  const rows: Array<{ label: string; detail: string; column: number }> = [];
  for (const raw of lines) {
    const line = stripLeftRule(raw);
    const m = line.match(NUMBERED_OPTION) ?? line.match(CHECKBOX_OPTION);
    if (m) {
      if (rows.length >= MAX_CHOICES) break;
      const label = dropSidePanel(m[1]).trim();
      rows.push({ label, detail: '', column: labelColumn(line, label) });
      continue;
    }
    const last = rows[rows.length - 1];
    if (!last) continue;
    // A blank line ends the block: what follows it belongs to the prompt's
    // furniture, not to the option above.
    if (!line.trim()) {
      last.column = Number.POSITIVE_INFINITY;
      continue;
    }
    // Aligned with the label, or further in. Kimi sets its description flush
    // with the label above it, so "further in than the label" would miss every
    // one of them; the footer hints sit far to the left of it either way.
    if (indentOf(line) < last.column) continue;
    last.detail = joinWrapped(last.detail, dropSidePanel(line).trim());
  }

  // Mostly marked on the label alone - `Other` is the text row whatever
  // description an agent hangs off it - but a couple only mean it at the foot
  // of the list, where the picker draws its own rather than where an agent
  // wrote one.
  return rows.map((r, i) => ({
    label: r.label,
    detail: truncate(r.detail, MAX_DETAIL_CHARS),
    ...(isFreeText(r.label, { last: i === rows.length - 1 }) ? { freeText: true } : {}),
  }));
}

/** The same options with each description written after its label, which is
 *  how a single line of text has to carry both. Kept for callers that have one
 *  line to spend rather than a screen. */
export function extractNumberedChoices(lines: string[]): string[] {
  return extractChoiceRows(lines).map((c) => (c.detail ? `${c.label} - ${c.detail}` : c.label));
}


/** Cut to `max` characters, marking that something was cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The question the pane is waiting on: the last `?`-terminated line, or the
 * permission prompt's "Do you want to …" line. Falls back to the last line that
 * actually says something (raw tail, unsummarized — display insurance only).
 *
 * "Says something" is the part opencode forced. Its prompt ends in neither a
 * question mark nor `Do you want to`, so the fallback ran - and every line of
 * that pane starts with a rule, several are nothing else, so the notification a
 * wearer got was one box-drawing character. A line with no letter and no digit
 * in it is furniture, and furniture is never the question.
 */
export function extractQuestionLine(lines: string[], before = lines.length): string | undefined {
  return findQuestion(lines, before).text;
}


/**
 * The question, and whether it was recognised or merely the last thing on
 * screen.
 *
 * The difference decides whether a notification exists at all. A pane herdr
 * calls `blocked` is not always asking: claude sits blocked between turns, and
 * the scrape then finds no question and no options, so the fallback returned
 * whatever the TUI had drawn at the bottom - and a waiting item was built from
 * it regardless. On 2026-08-07 that put `⏵⏵ auto mode on (shift+tab to cycle)`
 * on a wearer's face as a question, and it would not go away: dismissing it
 * only cleared that copy, and the next blocked flicker made another.
 *
 * The damage was not only the wrong words. A waiting item claims double-tap -
 * on the conversation screen it means "later" rather than "back" - so a
 * notification nobody asked for and nobody could clear left the wearer unable
 * to leave the screen. That is what `confident` exists to prevent: a guess is
 * still worth SHOWING when something real is already known to be waiting, but
 * it is never worth interrupting someone for.
 */
export function findQuestion(
  lines: string[],
  before = lines.length,
): { text?: string; confident: boolean } {
  const clean = lines
    .slice(0, before)
    .map((l) => stripCursor(stripLeftRule(l)).trim())
    .filter((l) => l.length > 0 && /[\p{L}\p{N}]/u.test(l));

  // A line that ends in a question mark is where the question ends. Where it
  // *starts* is further up whenever the pane was too narrow to hold it, and
  // taking the last line alone said so out loud: a wearer was asked
  // `うしますか?` on 2026-08-12 - the tail four characters of a question about
  // fourteen workspaces, wrapped over three rows at 54 columns. Read backwards
  // from the mark, the same way the fallback reads backwards from the bottom.
  for (let i = clean.length - 1; i >= 0; i--) {
    if (/[?？]\s*$/.test(clean[i])) {
      return { text: paragraphEndingAt(clean, i), confident: true };
    }
    // The permission prompt's own line, which opens a sentence rather than
    // closing one - so it is the start of what to read, not the end of it.
    if (/do you want to/i.test(clean[i])) {
      return { text: clean[i], confident: true };
    }
  }

  // Otherwise the paragraph above the options rather than the line above them.
  // A question long enough to matter is long enough to wrap, and a pane wraps
  // it wherever its width falls, so one line of it is whichever fragment
  // happened to be last. Codex's trust prompt arrived as `injection. Trusting
  // the directory allows project-local config, hooks, and exec policies to
  // load.` - the tail of a sentence whose beginning said what was being decided.
  return { text: tailParagraph(clean), confident: false };
}

/** The run of lines at the end of `clean`, joined - one paragraph as the pane
 *  laid it out, up to the blank line that separates it from what came before. */
function tailParagraph(clean: string[]): string | undefined {
  return paragraphEndingAt(clean, clean.length - 1);
}

/**
 * The paragraph whose last line is `end`, joined back into one.
 *
 * `clean` has already dropped blanks, so the paragraph break has to be found
 * another way: a line the pane wrapped continues the one above it, and a line
 * it started fresh does not. Length is the only signal left, and the honest
 * version of it is that a short line ends a paragraph.
 */
function paragraphEndingAt(clean: string[], end: number): string | undefined {
  if (end < 0 || end >= clean.length) return undefined;
  const out: string[] = [clean[end]];
  // The line directly above is where the wrap column is read off - it is the
  // one that certainly belongs to this paragraph and was certainly cut by the
  // column rather than by its author. Every line further up has to match that
  // width to join, which is what keeps an unrelated long line above the
  // paragraph out of it.
  let column = 0;
  for (let i = end - 1; i >= 0; i--) {
    const w = displayWidth(clean[i]);
    if (column === 0) {
      // Nothing this short was wrapped: the author stopped there. Also what
      // stops a menu of short rows being read as one long paragraph.
      if (w < MIN_WRAP_WIDTH) break;
      column = w;
    } else if (Math.abs(w - column) > wrapTolerance(clean[i])) {
      break;
    }
    out.unshift(clean[i]);
    if (out.length >= MAX_QUESTION_LINES) break;
  }
  return out.reduce(joinWrapped);
}

/**
 * Where the wrap column is, and how exactly a line has to hit it.
 *
 * The column used to be assumed - a flat 60 - and it was the pane's own width
 * that had been in mind. A question is drawn inside the picker's box, indented
 * and ruled, so the wrap falls well short of the pane: claude's picker in an
 * 80-column pane wraps at 54. Every line of the question reached that and none
 * of them reached 60, so the join never fired and a wearer was asked
 * `うしますか?` - the tail four characters of the sentence.
 *
 * How near a line has to come depends on what it is written in. A CJK row is
 * broken wherever the column falls and stops a character short of it at worst;
 * a Latin one is broken at a space, so it stops wherever the next word began -
 * up to a long word short of the column. One tolerance for both is wrong for
 * one of them: at 2 an English paragraph stops joining, and at 15 a CJK
 * paragraph starts swallowing the line above it.
 */
const MIN_WRAP_WIDTH = 40;
const CJK_WRAP_TOLERANCE = 2;
const LATIN_WRAP_TOLERANCE = 15;

function wrapTolerance(line: string): number {
  return CJK_EDGE.test(line) ? CJK_WRAP_TOLERANCE : LATIN_WRAP_TOLERANCE;
}



/** However wrapped, a question that takes more than this is not being read off
 *  a pair of glasses anyway. */
const MAX_QUESTION_LINES = 3;

/**
 * Where the option block starts, so the question can be looked for above it.
 *
 * A question mark is not a reliable marker and never was outside English.
 * Japanese asks with `ください` or a full-width `？` or nothing at all, so the
 * search fell through to "the last line that says something" - and on a live
 * pane the last line that says something is whatever the TUI drew at the
 * bottom. On 2026-08-07 a wearer was shown `❯ ちなみに録画情報を見てください`,
 * which was the line THEY had just typed into the input box, presented to them
 * as the agent's question. Another read the same day produced
 * `⏵⏵ auto mode on (shift+tab to cycle)`.
 *
 * The structure says it without knowing any language: an agent writes its
 * question, then its options under it. So the question is the last thing said
 * above the first option, and nothing below the first option can be it.
 */
export function optionBlockStart(lines: string[]): number {
  for (const [i, raw] of lines.entries()) {
    const line = stripLeftRule(raw);
    if (NUMBERED_OPTION.test(line) || CHECKBOX_OPTION.test(line)) return i;
  }
  return lines.length;
}

/**
 * What opencode is asking, from the two lines it says it in.
 *
 * ```
 *   ┃  △ Permission required
 *   ┃    → Edit fixture.txt
 * ```
 *
 * Neither line alone is the question: the first says only that there is one,
 * the second only names its object. The generic fallback would take the lower
 * of the two and put `→ Edit fixture.txt` on the glasses, which reads as
 * something already done rather than something being asked. Joined, they say
 * what a wearer needs to decide on.
 */
export function extractPermissionRequest(lines: string[]): string | undefined {
  const clean = lines.map((l) => stripLeftRule(l).trim());
  const bare = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  for (let i = clean.length - 1; i >= 0; i--) {
    if (!/permission required/i.test(clean[i])) continue;
    const parts: string[] = [];
    // A short window, because the option row is further down the same pane and
    // is made of words too. Nothing legitimate sits more than a line or two
    // below the marker.
    for (let j = i + 1; j < Math.min(clean.length, i + 5) && parts.length < 2; j++) {
      if (!/[\p{L}\p{N}]/u.test(clean[j])) continue;
      const heading = clean[j].startsWith('#');
      parts.push(bare(clean[j]));
      // A heading names a category rather than a thing - `# Shell command` -
      // and stopping there tells a wearer only that a command wants running,
      // not which one, when which one is the entire decision. So a heading
      // takes the line under it with it, and anything else stands alone.
      if (!heading) break;
    }
    const label = bare(clean[i]);
    return parts.length > 0 ? `${label}: ${parts.join(': ')}` : label;
  }
  return undefined;
}

/** Which of these rows open a text field, by index. */
function indicesOf(rows: Array<{ freeText?: boolean }>): number[] | undefined {
  const out = rows.flatMap((r, i) => (r.freeText ? [i] : []));
  return out.length > 0 ? out : undefined;
}

/** A row that carries a box of its own, which on a multi-select is the pane's
 *  to tick - and, where it also takes text, is the field itself. */
const BOXED_ROW = /^\s*\[[ xX*✓✔]\]/;

/**
 * The rows that are a text field rather than a way to one.
 *
 * Only a multi-select has any. `[ ] Type something` is filled by typing while
 * the pane's cursor is on it, ticking the box in the same stroke; its digit
 * only ticks the box, and submitting it that way was measured on Claude Code
 * 2.1.228 returning an answer with nothing in it. `Chat about this` sits below
 * the closing rule with no box and is a choice like any other.
 */
export function fieldRowsOf(picker: PaneQuestion): number[] | undefined {
  if (!picker.multiSelect) return undefined;
  const out = picker.options.flatMap((o, i) =>
    o.freeText && BOXED_ROW.test(o.label) ? [i] : [],
  );
  return out.length > 0 ? out : undefined;
}

/**
 * The keys each row answers to, with the walk to a field worked out here.
 *
 * Deliberately not left to the app. Sending a key is all the glasses do with a
 * row, and everything about *which* key belongs on this side, where an agent
 * that redraws its picker can be followed by editing a reader - the app costs
 * an ehpk build and a store review to change, which is the reason more than one
 * thing in this file used to be wrong for a while.
 *
 * A field is reached by walking the pane's own cursor to it, from where the
 * reader measured that cursor. Sparse on purpose: every row this leaves unset
 * is answered by its own number, which is every row on every other list.
 *
 * The walk does not wrap. Overshooting a field does not pick the wrong option -
 * it types the wearer's words into it.
 */
export function choiceKeysOf(picker: PaneQuestion, fieldRows: number[] | undefined): string[] | undefined {
  if (!fieldRows) return picker.choiceKeys;
  const keys = [...(picker.choiceKeys ?? [])];
  const from = picker.choiceCursor ?? 0;
  for (const row of fieldRows) {
    const steps = row - from;
    // An empty walk is the pane already sitting on the row, and travels as the
    // empty string: a row with no key at all would fall back to its digit,
    // which is the key this exists to keep off a field.
    keys[row] = (steps >= 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(steps));
  }
  return keys;
}

interface WaitingPayload {
  text: string;
  choices?: string[];
  /** Index-aligned with `choices`, empty where an option had nothing to say. */
  choiceDetails?: string[];
  /** Indices into `choices` whose row opens a text field. */
  choiceFreeText?: number[];
  /** The key each choice answers to, when not its own position. */
  choiceKeys?: string[];
  choiceInput?: GlassesRelayItem['choiceInput'];
  choiceSelected?: number;
  /** Which of `choiceFreeText` are a field typed into where it stands. */
  choiceFieldRows?: number[];
  /** What finishes a multi-select, for the send row the app draws itself. */
  choiceSend?: string;
  /** Which way the pane's cursor walks between the options. */
  choiceAxis?: GlassesRelayItem['choiceAxis'];
}

/**
 * Which of a call's questions the pane is showing.
 *
 * One question needs no matching. Several draw a tab each, and the record
 * cannot say which is in front - but the front tab's question text is painted
 * on the pane and the others' is not (their headers are, and a header is a
 * word, not the question). Compared with all whitespace removed, because the
 * pane wraps the question wherever its width falls - mid-word in Japanese -
 * and every break is a character the record does not have. No match, or more
 * than one, returns nothing rather than a guess.
 */
export function matchOpenQuestion(questions: OpenQuestion[], paneText: string): OpenQuestion | undefined {
  if (questions.length === 1) return questions[0];
  const flat = (s: string) => s.replace(/\s+/g, '');
  const pane = flat(paneText);
  const hits = questions.filter((q) => pane.includes(flat(q.question)));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The payload a recorded question builds - the options as the agent wrote
 * them, in call order.
 *
 * Call order is the pane's own numbering, which is what makes the picker's
 * digits land: claude and kimi both number their options as the call listed
 * them. A multi-select's rows get the checkbox the pane draws on theirs,
 * because the box is what tells the app it is a multi-select at all
 * (`looksMultiSelect` on the glasses).
 */
function recordedPayload(q: OpenQuestion): WaitingPayload {
  const box = q.multiSelect ? '[ ] ' : '';
  const choices = q.options.map((o) =>
    clampDisplayWidth(normalizeRelayText(`${box}${o.label}`), MAX_CHOICE_WIDTH),
  );
  // Whole. How much of it fits is decided once, in `makeItem`, where the
  // number of options is finally known - two payload builders each guessing at
  // it separately is how the width came to be wrong in the first place.
  const choiceDetails = q.options.map((o) => (o.description ? normalizeRelayText(o.description) : ''));
  return { text: clampDisplayWidth(normalizeRelayText(q.question), MAX_TEXT_WIDTH), choices, choiceDetails };
}

async function assembleWaitingPayload(
  ws: WorkspaceInfo,
  tmuxPaneId: string,
): Promise<WaitingPayload | undefined> {
  // The name, not the id: the id is `w5Q`, which tells a wearer
  // nothing about which session is asking.
  const fallback = `Waiting for input: ${ws.name || ws.id}`;
  if (!ws.instanceId || !/^%[0-9A-Za-z]+$/.test(tmuxPaneId)) return { text: fallback };
  const herdrPaneId = toHerdrPaneId(ws.instanceId, tmuxPaneId);
  const raw = await glassesRelayDeps.readPaneText(herdrPaneId);
  if (!raw) return { text: fallback };

  const lines = raw.split('\n');

  // What the agent recorded beats anything read off the screen: the options
  // as it wrote them, in the pane's own numbering, with the descriptions the
  // screen truncates. The scrape proved it the hard way on 2026-08-10:
  // a three-question AskUserQuestion draws a tab per question plus the rows
  // that move between them, and the scrape served the description block, the
  // `Next` row and finally `Submit answers` / `Cancel` as options - every
  // digit the picker sent counted against a list the pane never had.
  //
  // `known: true` with no questions falls through on purpose: that is a
  // permission prompt or a between-turns block, and the screen still owns
  // both.
  const pane = ws.panes?.find((p) => p.paneId === tmuxPaneId);
  const record = await glassesRelayDeps.readAgentQuestions(pane?.agent, pane?.agentSessionId);
  if (record.known && record.questions?.length) {
    const open = matchOpenQuestion(record.questions, raw);
    if (open) return recordedPayload(open);
    // Several questions and the pane's text does not say which tab is in
    // front. The question the scrape can see still tells the wearer something
    // is being decided; options belonging to a tab they may not be shown
    // would be answered with keys meant for a different one, so none go.
    const guess = findQuestion(lines, optionBlockStart(lines));
    return { text: clampDisplayWidth(normalizeRelayText(guess.text ?? fallback), MAX_TEXT_WIDTH) || fallback };
  }
  const clamp = (c: string) => clampDisplayWidth(normalizeRelayText(c), MAX_CHOICE_WIDTH);
  const permission = extractPermissionRequest(lines);

  // An agent this side can read draws its question inside furniture of its own,
  // and that reader is the whole answer for it - no general rule runs
  // underneath. What the general rule found on a claude pane, twice on
  // 2026-08-12, was the agent's own output: a `grep` listing and four options
  // written out in a sentence, neither of which was a question.
  if (hasPaneReader(pane?.agent)) {
    // Fetched only where a reader says it needs it: it is a second read of the
    // same pane, and every agent whose cursor is a character in the text has
    // no use for it.
    const painted = readerNeedsPaint(pane?.agent)
      ? ((await glassesRelayDeps.readPaneAnsi(herdrPaneId))?.split('\n') ?? undefined)
      : undefined;
    const picker = readPaneQuestion(pane?.agent, { lines, painted });
    if (picker) {
      const fieldRows = fieldRowsOf(picker);
      return {
        text: clampDisplayWidth(normalizeRelayText(picker.question ?? fallback), MAX_TEXT_WIDTH) || fallback,
        choices: picker.options.map((o) => clamp(o.label)),
        choiceDetails: picker.options.map((o) => normalizeRelayText(o.detail)),
        choiceFreeText: indicesOf(picker.options),
        choiceKeys: choiceKeysOf(picker, fieldRows),
        choiceFieldRows: fieldRows,
        choiceSend: picker.choiceSend,
        // A list with no keys of its own is answered by walking the pane's
        // cursor, and both halves travel or neither does - an item carrying
        // options and no `choiceInput` reads as a numbered one, and the glasses
        // would type a digit where digits do nothing at all.
        ...(picker.choiceInput === 'arrow' && picker.choiceSelected !== undefined
          ? {
              choiceInput: 'arrow' as const,
              choiceSelected: picker.choiceSelected,
              ...(picker.choiceAxis ? { choiceAxis: picker.choiceAxis } : {}),
            }
          : {}),
      };
    }
    // Not the picker screen. A permission prompt is a different one - drawn
    // without the picker's frame, carried by no record, and the most frequent
    // thing a wearer answers - so the rows are read the general way there. It
    // is identified by its own wording (`Do you want to proceed?`, `Permission
    // required`), which is a good deal narrower than "some lines start with a
    // number" and is what keeps that general read off every other screen.
    if (permission || detectPaneState(lines) === 'permission_prompt') {
      const asked = findQuestion(lines, optionBlockStart(lines));
      const text = clampDisplayWidth(normalizeRelayText(permission ?? asked.text ?? fallback), MAX_TEXT_WIDTH);
      const rows = extractChoiceRows(lines);
      return rows.length > 0
        ? {
            text: text || fallback,
            choices: rows.map((c) => clamp(c.label)),
            choiceDetails: rows.map((c) => (c.detail ? normalizeRelayText(c.detail) : '')),
            choiceFreeText: indicesOf(rows),
          }
        : { text: text || fallback };
    }
    // Blocked and asking nothing - which is where claude spends the gaps
    // between turns, and is not worth a notification.
    return undefined;
  }

  const guess = findQuestion(lines, optionBlockStart(lines));
  const question = permission ?? guess.text;
  const text = clampDisplayWidth(normalizeRelayText(question ?? fallback), MAX_TEXT_WIDTH);

  const numbered = extractChoiceRows(lines);
  if (numbered.length > 0) {
    return {
      text: text || fallback,
      choices: numbered.map((c) => clamp(c.label)),
      choiceDetails: numbered.map((c) => (c.detail ? normalizeRelayText(c.detail) : '')),
      choiceFreeText: indicesOf(numbered),
    };
  }
  // Nothing a list-shaped reader recognises. The pane may still be offering a
  // row of options side by side, which only its colours can tell from the key
  // hints beside it - so the second read is the same pane again with its escape
  // sequences left on. Second rather than first on purpose: every agent that
  // already worked keeps the exact read it had, and the extra round trip is
  // spent only where the answer today is "no options at all".
  const painted = await glassesRelayDeps.readPaneAnsi(herdrPaneId);
  const inline = painted ? extractInlineChoices(painted.split('\n')) : undefined;
  if (!inline) {
    // No options, and nothing that reads as a question either: the pane is
    // blocked without asking, which is where claude spends the gaps between
    // turns. There is nothing here to put on a face.
    return permission || guess.confident ? { text: text || fallback } : undefined;
  }

  return {
    text: text || fallback,
    choices: inline.options.map(clamp),
    // Both travel or neither does. The walk that answers this pane starts from
    // `choiceSelected`, so an item that lost it on the way is one the glasses
    // cannot answer without guessing where the pane's cursor is - which is the
    // guess 0.3.64 took out of this code.
    choiceInput: 'arrow',
    choiceSelected: inline.selected,
  };
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
  answering?: {
    choiceInput?: GlassesRelayItem['choiceInput'];
    choiceSelected?: number;
    choiceDetails?: string[];
    /** Indices into `choices`, before any filtering here. */
    choiceFreeText?: number[];
    /** Index-aligned with `choices`, before any filtering here. */
    choiceKeys?: string[];
    /** Indices into `choices`, before any filtering here. */
    choiceFieldRows?: number[];
    /** Not indexed against `choices` at all - the send row is the app's own,
     *  drawn after the pane's options rather than being one of them. */
    choiceSend?: string;
    choiceAxis?: GlassesRelayItem['choiceAxis'];
  },
): GlassesRelayItem {
  const item: GlassesRelayItem = {
    id: randomUUID(),
    sessionId,
    kind,
    source,
    text: clampDisplayWidth(normalizeRelayText(text), MAX_TEXT_WIDTH) || '(empty)',
    // Set here rather than at each call site so every item carries one: the
    // app obeys this field and has no rule of its own to fall back on, and an
    // item that forgot it would be the one nobody is shown.
    //
    // A question takes the screen unconditionally — including from the
    // conversation of the very session asking, which is where it is least
    // visible: that view has the transcript, not the options. A notice yields
    // to the session it is about, since the reader can already see it.
    present: kind === 'waiting' ? 'takeover' : 'takeover-if-elsewhere',
    createdAt: Date.now(),
  };
  if (paneId) item.paneId = paneId;
  if (choices && choices.length > 0) {
    // Label and description are dropped together or not at all: the
    // description is addressed by its option's index, so a row filtered out of
    // one array and not the other puts every description after it against the
    // wrong option - which reads as working, and is the failure mode this file
    // spends most of its length avoiding.
    const rows = choices
      .slice(0, MAX_CHOICES)
      .map((c, i) => ({
        label: clampDisplayWidth(normalizeRelayText(c), MAX_CHOICE_WIDTH),
        detail: normalizeRelayText(answering?.choiceDetails?.[i] ?? ''),
        from: i,
      }))
      .filter((r) => r.label.length > 0);
    const kept = rows.map((r) => r.label);
    item.choices = kept;
    // Re-derived against the surviving rows: an index into the list as it was
    // asked for would point at a different option once one is gone.
    const freeText = (answering?.choiceFreeText ?? [])
      .map((i) => rows.findIndex((r) => r.from === i))
      .filter((i) => i >= 0);
    if (freeText.length > 0) item.choiceFreeText = freeText;
    // Re-indexed with the rows for the same reason: a key against the wrong
    // option is an answer to a question nobody asked.
    const keys = answering?.choiceKeys;
    if (keys) item.choiceKeys = rows.map((r) => keys[r.from] ?? String(r.from + 1));
    // Re-indexed with the rows for the third time. A row dropped here takes its
    // own marking with it rather than passing it to whatever moved up into its
    // place - which would be the app typing a wearer's words into an option
    // they had picked to answer with.
    const fields = (answering?.choiceFieldRows ?? [])
      .map((i) => rows.findIndex((r) => r.from === i))
      .filter((i) => i >= 0);
    if (fields.length > 0) item.choiceFieldRows = fields;
    // Not re-indexed with the rows: it names no option. Dropping a row does
    // move the pane's Submit button one nearer, but the walk is measured on
    // the pane, where nothing was dropped.
    if (answering?.choiceSend) item.choiceSend = answering.choiceSend;
    const width = detailWidthFor(kept.length);
    const details = width > 0 ? rows.map((r) => clampDisplayWidth(r.detail, width)) : [];
    if (details.some((d) => d.length > 0)) item.choiceDetails = details;

    if (answering?.choiceInput === 'arrow') {
      // A numbered pane is answered by naming an option, so a list that lost a
      // row still answers the rest correctly. This one is answered by counting
      // steps along the pane's own row, so a dropped row moves every option
      // after it and the answer with it.
      //
      // When the list did not survive intact, the choices go rather than the
      // means of answering them. An item carrying options and no `choiceInput`
      // reads as a numbered one, and the glasses would type a digit at a pane
      // where digits do nothing at all - a picker that looks like it worked.
      // The question alone is the honest thing to show.
      const selected = answering.choiceSelected;
      const answerable =
        kept.length === choices.length &&
        selected !== undefined &&
        selected >= 0 &&
        selected < kept.length;
      if (answerable) {
        item.choiceInput = 'arrow';
        item.choiceSelected = selected;
        if (answering.choiceAxis) item.choiceAxis = answering.choiceAxis;
      } else {
        delete item.choices;
        delete item.choiceDetails;
      }
    }
  }
  if (kind === 'info') item.expiresAt = Date.now() + ttlMs;
  return item;
}

/**
 * The waiting item a scraped pane produces.
 *
 * Both callers build the same thing from the same payload — one on the pane
 * becoming blocked, one on it asking something else without ever unblocking —
 * and a field added to the payload has to reach both or the second question of
 * an opencode prompt arrives without the means to answer it.
 */
function waitingItem(sessionId: string, paneId: string, payload: WaitingPayload): GlassesRelayItem {
  return makeItem(
    sessionId,
    'waiting',
    'auto',
    payload.text,
    paneId,
    payload.choices,
    INFO_TTL_MS,
    {
      choiceInput: payload.choiceInput,
      choiceSelected: payload.choiceSelected,
      choiceDetails: payload.choiceDetails,
      choiceFreeText: payload.choiceFreeText,
      choiceKeys: payload.choiceKeys,
      choiceFieldRows: payload.choiceFieldRows,
      choiceSend: payload.choiceSend,
      choiceAxis: payload.choiceAxis,
    },
  );
}

/**
 * Agent self-note via `POST /api/glasses/relay` (the `hrdle glasses` CLI).
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
  /** Index-aligned with `choices`; what each one says about itself. */
  choiceDetails?: string[];
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
    const item = makeItem(input.sessionId, 'waiting', 'agent', input.text, input.paneId, input.choices, INFO_TTL_MS, {
      choiceDetails: input.choiceDetails,
    });
    slot.waiting = item;
    broadcastUpsert(item);
    return { status: 200, item };
  }

  const item = makeItem(input.sessionId, 'info', 'agent', input.text, input.paneId, input.choices, INFO_TTL_MS, {
    choiceDetails: input.choiceDetails,
  });
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
  const payload = await assembleWaitingPayload(ws, paneId);
  // Blocked without asking. herdr reports it for the gaps between turns as
  // well as for a question, and there is nothing on that pane worth a
  // notification - least of all one that would then claim double-tap.
  if (!payload) return;
  const item = waitingItem(ws.id, paneId, payload);
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
 * A fresh item rather than an edit in place - but only when the question
 * itself changed. The id is what tells a client "this is another decision"
 * from "the same one, redrawn", and a pane that redraws often will mint
 * questions out of nothing if those two are not kept apart.
 */
async function refreshBlocked(ws: WorkspaceInfo, paneId: string): Promise<void> {
  if (subscribers.size === 0) return; // presence gate, same as enterBlocked
  const slot = store.get(ws.id);
  const item = slot?.waiting;
  // Nothing here yet, and the pane is blocked: it may have begun asking without
  // a transition to announce it. That is the ordinary case rather than an edge
  // one - a pane holding queued input is already blocked when the question
  // appears, so `enterBlocked` never fires for it. Reported from the device on
  // 2026-08-07: the first question of a set never reached the glasses, and the
  // second did, because answering the first is what finally moved the status.
  //
  // It used to be covered by accident. A blocked pane always produced SOME
  // item, even when it was only the status bar read as a question, and this
  // function replaced that with the real one when it arrived. Declining to
  // build the junk took away the thing the real question was arriving into.
  if (!item) {
    await enterBlocked(ws, paneId);
    return;
  }
  if (!slot || item.source !== 'auto' || item.paneId !== paneId) return;
  // "Later / on PC" was said about this pane, and the wearer meant the pane
  // rather than the sentence. Re-raising it on every redraw would be arguing.
  if (item.dismissed) return;

  const payload = await assembleWaitingPayload(ws, paneId);
  // The question went away without the pane unblocking - the wearer answered
  // it at the keyboard, most likely. Keeping what is on the glasses is right:
  // `exitBlocked` is what takes an item down, and a redraw is not that.
  if (!payload) return;
  const next = waitingItem(ws.id, paneId, payload);
  // A read that came back with no options while the last one had them is far
  // more likely a half-drawn frame than a question that lost its choices - but
  // only while it is still the same question. A read that lost the options AND
  // changed the question is a new question the scrape could not parse, and
  // holding the old one there means showing the wearer options belonging to a
  // question the pane has already moved past. Wrong question with no options
  // beats right-looking options for the wrong question.
  if (item.choices?.length && !next.choices?.length && next.text === item.text) return;
  // Same question, and only the pane's own cursor has moved under it. That has
  // to reach the glasses - the walk that answers this pane starts from that
  // index - but it is NOT a new decision, and sending it as one is what broke a
  // wearer on 2026-08-07: seven identical permission prompts inside 1.3
  // seconds, each with an id of its own, so answering the first only revealed
  // the second. OpenCode's TUI redraws constantly and the highlight reads
  // slightly differently across frames; every flicker minted another question.
  //
  // Updated in place instead. The client keys by id, so the same id is an edit
  // and a new one is an interruption - which is the actual difference between
  // "the cursor moved" and "it is asking something else".
  if (next.text === item.text && sameChoices(item.choices, next.choices)) {
    const sameDetails = sameChoices(item.choiceDetails, next.choiceDetails);
    // Both of these are measured from where the pane's cursor is, so both go
    // stale the moment it moves - which a walk to a field row does, without
    // changing a label or a description. Refreshed here or a wearer who opened
    // that field and said nothing is left with a Send that walks from where
    // the cursor no longer is, and lands on an option.
    const sameWalks = next.choiceSend === item.choiceSend && sameChoices(item.choiceKeys, next.choiceKeys);
    if (next.choiceSelected === item.choiceSelected && sameDetails && sameWalks) return;
    item.choiceSelected = next.choiceSelected;
    // Not a new decision - the same options, saying a little more or less about
    // themselves as the pane redraws. Edited in place so the picker under the
    // wearer's finger keeps its id and its cursor.
    if (!sameDetails) item.choiceDetails = next.choiceDetails;
    if (!sameWalks) {
      item.choiceSend = next.choiceSend;
      item.choiceKeys = next.choiceKeys;
    }
    broadcastUpsert(item);
    return;
  }

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
 * (source 'agent', posted via `hrdle glasses`) have their own lifecycle —
 * answered→dismissed — and are NOT tied to any pane's blocked state, so an
 * unrelated pane unblocking must never drop them. Auto items always
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
  /** The agent's own record of what it is asking — see agent-question.ts. */
  readAgentQuestions: (
    agent: AgentProvider | undefined,
    agentSessionId: string | undefined,
  ): Promise<QuestionsRead> => readAgentQuestions(agent, agentSessionId),
  /**
   * The same read with its escape sequences left on.
   *
   * A row of side-by-side options and the row of key hints beside it are the
   * same shape as text and different colours as pixels, so the only reader that
   * can tell them apart needs the colours. `readPane` already asked herdr for
   * `format: 'ansi'` — `strip_ansi: false` alone does not do it, the format is
   * what decides.
   */
  readPaneAnsi: (herdrPaneId: string): Promise<string | null> =>
    readPane(herdrPaneId, 'recent', 30),
};

/** Test hook: wipe all module state. */
export function resetGlassesRelayForTest(): void {
  store.clear();
  postLog.clear();
  paneStatus.clear();
  subscribers.clear();
  deviceSubscribers.clear();
}
