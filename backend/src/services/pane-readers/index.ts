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

export type { PickerOption } from './claude';

export interface PaneQuestion {
  /** The question as the pane wrapped it, rejoined; absent when only the
   *  options could be read. */
  question?: string;
  options: PickerOption[];
  multiSelect: boolean;
}

/**
 * The agents whose picker this side can read off the screen.
 *
 * Deliberately short. Adding one means writing a reader against a captured pane
 * and a test that holds that capture - not relaxing a pattern until it matches.
 *
 * The agents missing from it are not unsupported: `kimi` writes its question to
 * a record that `agent-question.ts` reads, and `opencode` draws its options
 * side by side in colour, which `glasses-relay.ts` reads separately because it
 * needs the escape sequences this path has already had stripped. What they do
 * not get is a guess made from the shape of their output.
 */
const READERS: Partial<Record<AgentProvider, (lines: string[]) => PaneQuestion | undefined>> = {
  claude: readClaudePicker,
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
