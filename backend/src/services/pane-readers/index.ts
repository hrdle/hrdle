/**
 * What a pane is asking, read the way that pane's agent draws it.
 *
 * There used to be one reader for all of them: find lines that begin with a
 * number, take the longest run, call it a menu. It could not tell a question
 * from a listing because nothing about a numbered line says which it is - and
 * on 2026-08-12 a wearer was offered `71` / `const INFO_TTL_MS = 5 * 60_000;`
 * off a `grep`, and four options out of a sentence Claude had written in prose.
 *
 * The agent running in the pane is known (`PaneInfo.agent`), and each one draws
 * its question inside furniture of its own. So the reading is dispatched on it,
 * and **an agent with no reader gets no options** rather than the general rule.
 * That default is the point of the change: a guess offered to someone wearing
 * the glasses costs more than a question shown without its options, because the
 * guess is answered and the omission is only read.
 *
 * The blast radius is per agent too. A TUI that changes breaks its own reader
 * and no one else's, which was not true of the shape-matching one - Claude's
 * preview panel arriving broke the reading of every agent's options at once.
 */

import type { AgentProvider } from '../../../../shared/types';
import { readClaudePicker } from './claude';
import type { PickerOption } from './claude';
import { readGrokPicker } from './grok';
import { readKimiPrompt } from './kimi';

export type { PickerOption } from './claude';

export interface PaneQuestion {
  /** The question as the pane wrapped it, rejoined; absent when only the
   *  options could be read. */
  question?: string;
  options: PickerOption[];
  multiSelect: boolean;
  /**
   * How the pane takes an answer, when it is not by the option's own number.
   *
   * `arrow` is a list with no keys of its own - kimi's trust prompt, OpenCode's
   * permission row - answered by walking the pane's own cursor to the row and
   * pressing Enter. The walk needs a starting point, which is `choiceSelected`,
   * and an item carrying one without the other cannot be answered at all.
   */
  choiceInput?: 'number' | 'arrow';
  choiceSelected?: number;
  /** The key each option answers to, when it is not the option's position. */
  choiceKeys?: string[];
}

/**
 * The agents whose picker this side can read off the screen.
 *
 * Deliberately short. Adding one means writing a reader against a captured pane
 * and a test that holds that capture - not relaxing a pattern until it matches.
 *
 * The agents missing from it are not unsupported: `opencode` draws its options
 * side by side in colour, which `glasses-relay.ts` reads separately because it
 * needs the escape sequences this path has already had stripped. What they do
 * not get is a guess made from the shape of their output.
 *
 * kimi has both a reader and a record. The record (`agent-question.ts`) carries
 * its `AskUserQuestion`; the reader carries the two prompts the record knows
 * nothing about, its approval and its trust screens.
 */
const READERS: Partial<Record<AgentProvider, (lines: string[]) => PaneQuestion | undefined>> = {
  claude: readClaudePicker,
  kimi: readKimiPrompt,
  grok: readGrokPicker,
};

export function readPaneQuestion(agent: AgentProvider | undefined, lines: string[]): PaneQuestion | undefined {
  if (!agent) return undefined;
  return READERS[agent]?.(lines);
}

/** Whether this side has a reader for the agent at all — the caller needs to
 *  tell "read it, and it is asking nothing" from "cannot read this one", and
 *  they are different answers. */
export function hasPaneReader(agent: AgentProvider | undefined): boolean {
  return !!agent && agent in READERS;
}
