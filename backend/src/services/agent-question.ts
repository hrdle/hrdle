import { locateSessionFile } from '../utils/locate-session-file';
import { readLastLines } from '../utils/read-last-lines';
import { KimiSessionStore, kimiWirePath } from './kimi';
import type { AgentProvider } from '../../../shared/types';

/**
 * The question an agent is waiting on, read from the agent's own record rather
 * than from the screen it drew.
 *
 * Everything the glasses show about a question was scraped out of the pane:
 * find a line ending in `?`, find rows that look like a numbered list, and -
 * where neither shape fits - find a row where exactly one item is painted
 * differently. That last one is a guess about pixels, and on 2026-08-08 it
 * guessed wrong on a Claude pane that was not asking anything at all: a `Read`
 * result scrolled past, one row of it held a line number and a line of code
 * with a gap between them, and a wearer was offered
 * `1039 / const pane = state.selectedPaneId` as the answer to a question
 * nobody had asked. The same reader had already offered a kimi question's tab
 * bar as its own answer.
 *
 * Both agents write the question down. Claude's transcript carries the
 * `AskUserQuestion` tool call with its options and their descriptions; kimi's
 * wire carries `interaction.request` with `kind: "question"` in the same
 * shape. Hrdle already reads both files - for the conversation view, the
 * recap and the token usage - so this is a third reading of a file that is
 * open anyway, and it cannot mistake a listing for a menu because it never
 * looks at one.
 *
 * What this does **not** replace: a permission prompt ("Do you want to
 * proceed?"). That is the agent's own UI rather than a tool call, and it is
 * not in either record - the screen is still the only place it exists.
 */
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface OpenQuestion {
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  /**
   * The call carried more than one question.
   *
   * The pane then draws a tab per question and answers whichever tab is in
   * front, and *which* one that is lives on the screen and nowhere else. The
   * record cannot say, so a caller that needs to answer must not assume the
   * first one is showing.
   */
  ambiguous: boolean;
}

/** How far back either record is read. A question is the last thing that
 *  happened on a pane that is waiting on one. */
const TAIL_LINES = 400;

interface RawQuestion {
  question?: unknown;
  multiSelect?: unknown;
  options?: unknown;
}

/** Both agents write the same shape, so both parse through here. */
function toOpenQuestion(raw: unknown, count: number): OpenQuestion | undefined {
  const q = raw as RawQuestion | undefined;
  if (!q || typeof q.question !== 'string' || !q.question.trim()) return undefined;
  if (!Array.isArray(q.options)) return undefined;
  const options: QuestionOption[] = [];
  for (const entry of q.options) {
    const o = entry as { label?: unknown; description?: unknown };
    if (!o || typeof o.label !== 'string' || !o.label.trim()) continue;
    options.push({
      label: o.label.trim(),
      description: typeof o.description === 'string' && o.description.trim() ? o.description.trim() : undefined,
    });
  }
  if (options.length === 0) return undefined;
  return {
    question: q.question.trim(),
    options,
    multiSelect: q.multiSelect === true,
    ambiguous: count > 1,
  };
}

interface ClaudeEntry {
  type?: string;
  message?: {
    content?: Array<{
      type?: string;
      name?: string;
      id?: string;
      tool_use_id?: string;
      input?: { questions?: unknown };
    }>;
  };
}

/**
 * Claude's open `AskUserQuestion`, if one is waiting.
 *
 * Open means asked and not yet answered: the tool call is in the transcript
 * and no `tool_result` carrying its id has followed. That is the same test
 * `ClaudeCodeService.checkWaitingState` makes to decide the pane is waiting,
 * made here for the content rather than for the fact.
 */
export async function openClaudeQuestion(sessionId: string, projectsDir?: string): Promise<OpenQuestion | undefined> {
  const path = await locateSessionFile(sessionId, projectsDir);
  if (!path) return undefined;
  const text = await readLastLines(path, TAIL_LINES);
  if (!text) return undefined;

  const entries: ClaudeEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ClaudeEntry);
    } catch {
      // A tail slice can open mid-record.
    }
  }

  const answered = new Set<string>();
  for (const entry of entries) {
    for (const part of entry.message?.content ?? []) {
      if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') answered.add(part.tool_use_id);
    }
  }

  // Backwards: the newest unanswered call is the one on screen.
  for (let i = entries.length - 1; i >= 0; i--) {
    for (const part of entries[i].message?.content ?? []) {
      if (part?.type !== 'tool_use' || part.name !== 'AskUserQuestion') continue;
      if (typeof part.id === 'string' && answered.has(part.id)) continue;
      const questions = part.input?.questions;
      if (!Array.isArray(questions) || questions.length === 0) continue;
      return toOpenQuestion(questions[0], questions.length);
    }
  }
  return undefined;
}

interface KimiRecord {
  type?: string;
  id?: unknown;
  kind?: unknown;
  request?: { questions?: unknown };
}

/**
 * Kimi's open question, if one is waiting.
 *
 * Same test in kimi's own vocabulary: an `interaction.request` of
 * `kind: "question"` with no `interaction.resolved` carrying its id after it.
 * The `approval` kind is deliberately not read - that is kimi's permission
 * prompt, which the screen still owns.
 */
export async function openKimiQuestion(sessionId: string, store = new KimiSessionStore()): Promise<OpenQuestion | undefined> {
  const session = await store.findSession(sessionId);
  if (!session) return undefined;
  let text: string;
  try {
    text = await readLastLines(kimiWirePath(session.dir), TAIL_LINES);
  } catch {
    return undefined;
  }
  if (!text) return undefined;

  const records: KimiRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as KimiRecord);
    } catch {
      // As above: the slice can open mid-record.
    }
  }

  const resolved = new Set<string>();
  for (const record of records) {
    if (record.type === 'interaction.resolved' && typeof record.id === 'string') resolved.add(record.id);
  }

  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type !== 'interaction.request' || record.kind !== 'question') continue;
    if (typeof record.id === 'string' && resolved.has(record.id)) continue;
    const questions = record.request?.questions;
    if (!Array.isArray(questions) || questions.length === 0) continue;
    return toOpenQuestion(questions[0], questions.length);
  }
  return undefined;
}

/**
 * What an agent's own record says about a question, including whether it is in
 * a position to say anything at all.
 *
 * The two "no" answers are different and the caller has to tell them apart.
 * `known: false` is "this agent keeps no record I can read" - codex, grok and
 * opencode today - and the screen is still the only source there. `known: true`
 * with no question is the agent stating that nothing is being asked, and that
 * is the one worth having: it is what makes a menu found on the screen
 * refusable. A permission prompt is not a question and lands here too, so a
 * caller must not read this as "nothing is waiting".
 */
export type QuestionRead =
  | { known: false }
  | { known: true; question?: OpenQuestion };

export async function readAgentQuestion(
  agent: AgentProvider | undefined,
  sessionId: string | undefined,
): Promise<QuestionRead> {
  if (!sessionId) return { known: false };
  if (agent === 'claude') return { known: true, question: await openClaudeQuestion(sessionId) };
  if (agent === 'kimi') return { known: true, question: await openKimiQuestion(sessionId) };
  return { known: false };
}
