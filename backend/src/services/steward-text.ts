/**
 * Fitting what the steward writes to the page it is written for.
 *
 * `text` and `detail` are one field written twice, and only the writer knows
 * where the split belongs - but measured on the first sessions the observer
 * wrote for real, it does not make one: turns of 512 and 649 characters with
 * `detail` empty on every one of them.
 *
 * So the overflow is **moved** rather than cut. Nothing is lost, the response
 * says it happened, and the same string reaches the glasses and the phone
 * already fitted - a clamp in each renderer would have them disagree about what
 * the turn said.
 */

import { displayWidth } from './glasses-relay';

/** One G2 page: seven lines of 52 columns. */
export const GLASSES_PAGE_WIDTH = 364;

/** A cut this early reads as a fragment, so the page boundary wins instead. */
const MIN_SENTENCE_CUT = Math.floor(GLASSES_PAGE_WIDTH / 2);

const SENTENCE_END = /[。．！？!?\n]/;

export interface FittedText {
  text: string;
  detail?: string;
  /** Whether the caller's split was overridden. */
  spilled: boolean;
}

export function fitToPage(text: string, detail?: string): FittedText {
  if (displayWidth(text) <= GLASSES_PAGE_WIDTH) return { text, detail, spilled: false };

  const chars = Array.from(text);
  let width = 0;
  let cut = 0;
  let sentenceCut = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const next = width + displayWidth(ch);
    // A sentence end may take the last column; a mid-sentence cut has to leave
    // one for the ellipsis that says it was cut.
    if (next > GLASSES_PAGE_WIDTH) break;
    width = next;
    if (SENTENCE_END.test(ch) && width >= MIN_SENTENCE_CUT) sentenceCut = i + 1;
    if (next <= GLASSES_PAGE_WIDTH - 1) cut = i + 1;
  }

  const at = sentenceCut || cut;
  const head = chars.slice(0, at).join('').trimEnd();
  const rest = chars.slice(at).join('').trim();

  return {
    text: sentenceCut ? head : `${head}…`,
    detail: detail ? `${rest}\n\n${detail}` : rest,
    spilled: true,
  };
}
