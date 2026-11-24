import { createHash } from 'node:crypto';
import type { AgentProvider } from '../../../shared/types';
import { type OpenQuestion, type QuestionsRead, readAgentQuestions } from './agent-question';
import { choiceKeysOf, fieldRowsOf, matchOpenQuestion } from './glasses-relay';
import type { HerdrAgentStatus } from './herdr-client';
import { type PaneQuestion, readPaneQuestion } from './pane-readers';
import { type ClaudePermission, readClaudePermission } from './pane-readers/claude-permission';

/**
 * The question a pane is waiting on, as data a program can relay and answer.
 *
 * The glasses already had all of this, but cut to the G2's panel (a 120-wide
 * question, 52-wide options, nine at most) and with the knowledge of which key
 * answers which row living in the app. A caller relaying the question to a
 * person needs it whole, and a caller answering it needs that knowledge on this
 * side.
 *
 * **Only screens with a reader of their own.** Claude's picker is read by its
 * frame (`pane-readers/claude.ts`) - the chip above and the `Enter to select`
 * footer below - because Claude Code does not write an open `AskUserQuestion`
 * to its transcript until it is answered. Kimi's question is read from its wire
 * (`agent-question.ts`). Claude's permission prompt has a frame of its own too
 * (`pane-readers/claude-permission.ts`) and is served as `kind: 'permission'`.
 * Every other agent's prompts are left out: there the screen is read by its
 * shape, and a guess handed to another program is relayed to a person as fact.
 */

export interface StructuredOption {
  index: number;
  label: string;
  description?: string;
  /** Multi-select only: whether the box is ticked on the pane right now. */
  checked?: boolean;
  /** Choosing it means supplying `text`. */
  freeText?: boolean;
  /** With `freeText`: it may also be chosen without text. */
  textOptional?: boolean;
}

export interface StructuredQuestion {
  /**
   * Changes when anything that decides an answer changes - the question, the
   * options, single or multi - and not when a box is ticked. An answer carries
   * it back, so one composed for a question that has since been replaced is
   * refused rather than typed into the next one.
   */
  questionId: string;
  agent: AgentProvider;
  /** `record`: the agent's own record. `screen`: the agent's picker, read by its frame. */
  source: 'record' | 'screen';
  question: string;
  multiSelect: boolean;
  options: StructuredOption[];
  /** Absent for a question; `permission` for a tool waiting to be allowed. */
  kind?: 'permission';
  /** Permission only: what wants it (`Bash command`, `Edit file`) and what it will do. */
  title?: string;
  detail?: string;
}

/** What answering needs and the caller does not: the keys. */
interface AnswerKeys {
  /** Index-aligned with `options`. */
  keys: string[];
  /** Rows of a multi-select that are a text field typed into where it stands. */
  fieldRows: number[];
  /** Options that carry no checkbox on a multi-select (an action, not a tick). */
  actionRows: number[];
  /** The walk to the pane's Submit button and the Enter that presses it. */
  send?: string;
  /** The keys that open a text field in a row (`Tab to amend`); the text and an Enter follow. */
  amend?: { index: number; keys: string };
}

export type PaneQuestionRead =
  | { status: 'question'; question: StructuredQuestion; keys: AnswerKeys }
  /** Blocked, but on something that is not a question this side reads. */
  | { status: 'none' }
  | { status: 'not-blocked' }
  /** No structured reader for this agent. */
  | { status: 'unsupported'; agent?: AgentProvider }
  /** A call with several questions and the pane does not show which is in front. */
  | { status: 'ambiguous' };

export interface PaneSnapshot {
  agent?: AgentProvider;
  agentSessionId?: string;
  agentStatus?: HerdrAgentStatus;
  /** The pane's text, escape sequences stripped. */
  text: string | null;
}

export interface PaneQuestionDeps {
  readAgentQuestions: (agent: AgentProvider | undefined, sessionId: string | undefined) => Promise<QuestionsRead>;
}

const defaultDeps: PaneQuestionDeps = { readAgentQuestions };

const BOX = /^\[([ xX*✓✔])\]\s*/;

function questionIdOf(
  agent: AgentProvider,
  question: string,
  multiSelect: boolean,
  labels: string[],
  context?: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([agent, question, multiSelect, labels, context ?? null]))
    .digest('hex')
    .slice(0, 16);
}

function fromPicker(picker: PaneQuestion): PaneQuestionRead {
  const fieldRows = fieldRowsOf(picker) ?? [];
  const pickerKeys = choiceKeysOf(picker, fieldRows.length > 0 ? fieldRows : undefined) ?? [];
  const actionRows: number[] = [];
  const options: StructuredOption[] = picker.options.map((o, i) => {
    const box = o.label.match(BOX);
    const option: StructuredOption = { index: i, label: box ? o.label.slice(box[0].length).trim() : o.label };
    if (o.detail) option.description = o.detail;
    if (picker.multiSelect) {
      if (box) option.checked = box[1] !== ' ';
      else actionRows.push(i);
    }
    if (o.freeText) option.freeText = true;
    return option;
  });
  const question = picker.question ?? '';
  return {
    status: 'question',
    question: {
      questionId: questionIdOf('claude', question, picker.multiSelect, options.map((o) => o.label)),
      agent: 'claude',
      source: 'screen',
      question,
      multiSelect: picker.multiSelect,
      options,
    },
    keys: {
      keys: options.map((_, i) => pickerKeys[i] ?? String(i + 1)),
      fieldRows,
      actionRows,
      ...(picker.choiceSend ? { send: picker.choiceSend } : {}),
    },
  };
}

/** Detail lines past this are a long diff, and the pane shows the rest. */
const MAX_PERMISSION_DETAIL_LINES = 40;

function fromPermission(p: ClaudePermission): PaneQuestionRead {
  // The last "No" row is the one that tells Claude what to do instead.
  const deny = p.amend ? p.options.findLastIndex((o) => /^no\b/i.test(o.label)) : -1;
  const options: StructuredOption[] = p.options.map((o, i) => ({
    index: i,
    label: o.label,
    ...(o.description ? { description: o.description } : {}),
    ...(i === deny ? { freeText: true, textOptional: true } : {}),
  }));
  const detail = p.detail.slice(0, MAX_PERMISSION_DETAIL_LINES).join('\n');
  const steps = deny - p.cursor;
  const walk = (steps > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(steps));
  return {
    status: 'question',
    question: {
      // The detail is in the id: two Bash prompts in a row ask the same
      // question with the same rows, and an answer meant for the first must not
      // allow the second.
      questionId: questionIdOf('claude', p.question, false, options.map((o) => o.label), `${p.title}\n${detail}`),
      agent: 'claude',
      source: 'screen',
      kind: 'permission',
      title: p.title,
      ...(detail ? { detail } : {}),
      question: p.question,
      multiSelect: false,
      options,
    },
    keys: {
      keys: options.map((_, i) => String(i + 1)),
      fieldRows: [],
      actionRows: [],
      ...(deny >= 0 ? { amend: { index: deny, keys: `${walk}\t` } } : {}),
    },
  };
}

function fromRecord(agent: AgentProvider, q: OpenQuestion): PaneQuestionRead {
  const options: StructuredOption[] = q.options.map((o, i) => ({
    index: i,
    label: o.label,
    ...(o.description ? { description: o.description } : {}),
  }));
  return {
    status: 'question',
    question: {
      questionId: questionIdOf(agent, q.question, q.multiSelect, options.map((o) => o.label)),
      agent,
      source: 'record',
      question: q.question,
      multiSelect: q.multiSelect,
      options,
    },
    // The record carries no keys. Kimi numbers its options in call order, which
    // is what the glasses have always sent it.
    keys: { keys: options.map((_, i) => String(i + 1)), fieldRows: [], actionRows: [] },
  };
}

export async function readStructuredQuestion(
  pane: PaneSnapshot,
  deps: PaneQuestionDeps = defaultDeps,
): Promise<PaneQuestionRead> {
  const blocked = pane.agentStatus === 'blocked';
  if (pane.agent === 'claude') {
    // The frame is the evidence, not herdr's status: right after an answer the
    // status can lag the screen by a poll, and the next tab of the call is
    // already drawn.
    const picker = pane.text ? readPaneQuestion('claude', { lines: pane.text.split('\n') }) : undefined;
    if (picker) return fromPicker(picker);
    const permission = pane.text ? readClaudePermission(pane.text.split('\n')) : undefined;
    if (permission) return fromPermission(permission);
    return blocked ? { status: 'none' } : { status: 'not-blocked' };
  }
  if (pane.agent === 'kimi') {
    if (!blocked) return { status: 'not-blocked' };
    const record = await deps.readAgentQuestions('kimi', pane.agentSessionId);
    if (!record.known || !record.questions?.length) return { status: 'none' };
    const open = matchOpenQuestion(record.questions, pane.text ?? '');
    return open ? fromRecord('kimi', open) : { status: 'ambiguous' };
  }
  return { status: 'unsupported', ...(pane.agent ? { agent: pane.agent } : {}) };
}

// =============================================================================
// Answering
// =============================================================================

export interface AnswerRequest {
  questionId: string;
  /** Indices into `options`. One for a single-select; the full ticked set for a multi-select. */
  choices: number[];
  /** The words for a chosen `freeText` option. */
  text?: string;
}

/**
 * One thing done to the pane. `keys` is split into single keystrokes when sent;
 * `type` is written as one piece; `prompt` is a bracketed paste and an Enter,
 * which is how a free-text row that opened the input box is finished.
 * `send` is the Submit walk, measured again after everything before it, because
 * walking to a field moves the pane's cursor and the walk measured before that
 * starts from the wrong row.
 */
export type AnswerStep =
  | { kind: 'keys'; data: string }
  | { kind: 'type'; data: string }
  | { kind: 'prompt'; data: string }
  | { kind: 'send' };

export type AnswerPlan = { ok: true; steps: AnswerStep[] } | { ok: false; status: 400 | 409; error: string };

export function planAnswer(read: PaneQuestionRead, req: AnswerRequest): AnswerPlan {
  if (read.status !== 'question') {
    return { ok: false, status: 409, error: `no question to answer (${read.status})` };
  }
  const { question, keys } = read;
  if (req.questionId !== question.questionId) {
    return { ok: false, status: 409, error: 'the question on the pane has changed' };
  }
  const n = question.options.length;
  const choices = req.choices;
  if (
    choices.length === 0 ||
    new Set(choices).size !== choices.length ||
    choices.some((c) => !Number.isInteger(c) || c < 0 || c >= n)
  ) {
    return { ok: false, status: 400, error: `choices must be distinct indices in 0..${n - 1}` };
  }
  const text = req.text?.trim() ? req.text : undefined;
  const chosenFree = choices.filter((c) => question.options[c].freeText);
  if (text && chosenFree.length === 0) {
    return { ok: false, status: 400, error: 'text is only accepted with a freeText option' };
  }
  if (!text && chosenFree.some((c) => !question.options[c].textOptional)) {
    return { ok: false, status: 400, error: 'a freeText option needs text' };
  }
  if (chosenFree.length > 1) {
    return { ok: false, status: 400, error: 'only one freeText option can be chosen' };
  }

  const single = (index: number): AnswerPlan => {
    if (text && keys.amend?.index === index) {
      return { ok: true, steps: [{ kind: 'keys', data: keys.amend.keys }, { kind: 'prompt', data: text }] };
    }
    const steps: AnswerStep[] = [{ kind: 'keys', data: keys.keys[index] }];
    if (question.options[index].freeText && text) steps.push({ kind: 'prompt', data: text });
    return { ok: true, steps };
  };

  if (!question.multiSelect) {
    if (choices.length !== 1) return { ok: false, status: 400, error: 'a single-select takes exactly one choice' };
    return single(choices[0]);
  }

  // An option without a box on a multi-select (`Chat about this`) leaves the
  // list rather than ticking a row of it.
  const actions = choices.filter((c) => keys.actionRows.includes(c));
  if (actions.length > 0) {
    if (choices.length !== 1) {
      return { ok: false, status: 400, error: 'an option without a checkbox must be chosen on its own' };
    }
    return single(actions[0]);
  }

  if (question.source !== 'screen' || !keys.send) {
    return { ok: false, status: 409, error: 'this multi-select cannot be submitted from here' };
  }

  const steps: AnswerStep[] = [];
  // Digits first: they tick a box without moving the pane's cursor, so every
  // walk measured on the read still starts where it says.
  for (const option of question.options) {
    if (keys.fieldRows.includes(option.index)) continue;
    const want = choices.includes(option.index);
    if (want !== (option.checked === true)) steps.push({ kind: 'keys', data: keys.keys[option.index] });
  }
  const field = choices.find((c) => keys.fieldRows.includes(c));
  if (field !== undefined && text) {
    // Typed where it stands, without an Enter: Enter on a picker row toggles it.
    if (keys.keys[field]) steps.push({ kind: 'keys', data: keys.keys[field] });
    steps.push({ kind: 'type', data: text });
  }
  steps.push({ kind: 'send' });
  return { ok: true, steps };
}

/** One keystroke per write: Claude Code reads a chunk as one key and drops the rest. */
export function splitKeystrokes(data: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] !== '\x1b') {
      out.push(data[i]);
      i++;
      continue;
    }
    let j = i + 1;
    if (data[j] === '[' || data[j] === 'O') {
      j++;
      while (j < data.length && !/[@-~]/.test(data[j])) j++;
      j++;
    } else {
      j++;
    }
    out.push(data.slice(i, j));
    i = j;
  }
  return out;
}

export interface AnswerIo {
  write: (data: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** A fresh read of the same pane. */
  reread: () => Promise<PaneQuestionRead>;
}

export const KEYSTROKE_GAP_MS = 40;
/** Long enough for the pane to redraw what the last key did before it is read again. */
export const SETTLE_MS = 400;

export async function executeAnswer(
  steps: AnswerStep[],
  io: AnswerIo,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const step of steps) {
    if (step.kind === 'keys') {
      for (const key of splitKeystrokes(step.data)) {
        // Awaited, not merely spaced: two writes in flight arrive in whichever
        // order they finish, and a walk delivered out of order presses
        // whatever it lands on.
        await io.write(key);
        await io.sleep(KEYSTROKE_GAP_MS);
      }
    } else if (step.kind === 'type') {
      await io.write(step.data);
      await io.sleep(KEYSTROKE_GAP_MS);
    } else if (step.kind === 'prompt') {
      await io.sleep(SETTLE_MS);
      await io.write(`\x1b[200~${step.data}\x1b[201~`);
      // Its own write, later: a \r in the same chunk as the paste terminator is
      // taken as part of the paste.
      await io.sleep(80);
      await io.write('\r');
    } else {
      await io.sleep(SETTLE_MS);
      const now = await io.reread();
      const send = now.status === 'question' ? now.keys.send : undefined;
      if (!send) return { ok: false, error: 'the Submit button could not be found after filling in the answer' };
      for (const key of splitKeystrokes(send)) {
        await io.write(key);
        await io.sleep(KEYSTROKE_GAP_MS);
      }
    }
  }
  return { ok: true };
}

/** The response shape: the read without the keys, which are this side's business. */
export function publicRead(read: PaneQuestionRead): Exclude<PaneQuestionRead, { status: 'question' }> | {
  status: 'question';
  question: StructuredQuestion;
} {
  if (read.status !== 'question') return read;
  return { status: 'question', question: read.question };
}
