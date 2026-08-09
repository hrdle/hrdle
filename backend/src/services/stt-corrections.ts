/**
 * Deterministic repairs applied to a transcript before it reaches the wearer,
 * for the two things the vocabulary prompt provably cannot fix.
 *
 * Both were measured rather than guessed. The glasses screen recording
 * (`glasses-screen-recorder.ts`) keeps every frame it drew, and the voice
 * screen's `[confirm]` frame *is* the transcript, so eight days of them
 * (2026-08-02..09) read back as 1030 real utterances.
 *
 * **Spelling.** A prompt is context, not an instruction about how to write the
 * answer. `herdr` sat in the glossary for all eight days and came back as
 * ハーダー ten times and as `herdr` never once; `issue` came back as イシュー
 * twenty-three times. The model heard the word correctly every time — it just
 * wrote it the ordinary Japanese way, which is the one thing a prompt has no
 * say over. Spelling is therefore fixed here, where it is a lookup instead of
 * a hope, and those terms are no longer spent on prompt budget upstream.
 *
 * **Hallucination.** Whisper fills silence with whatever its training data put
 * after silence, and for Japanese that is a video sign-off:
 * `ご視聴ありがとうございました` arrived thirteen times in those eight days and
 * nobody ever said it. These are matched as the *whole* transcript only. As a
 * substring the same words are ordinary speech — someone thanking someone is
 * not a defect — and dropping a phrase out of the middle of a real sentence
 * would be a worse failure than the one being fixed.
 *
 * Silence is not detected here. Deciding "this audio was empty" from the
 * amplitude of PCM this server never listened to would mean choosing a
 * threshold with no measurement behind it, and being wrong that way is
 * invisible: the wearer speaks, nothing comes back, and there is no artifact
 * saying why. Dropping a known sign-off is recoverable in a way that dropping
 * unheard speech is not.
 */

/**
 * Whole transcripts that mean "there was nothing to transcribe".
 *
 * Compared after trimming and after stripping trailing Japanese and ASCII
 * sentence punctuation, since the same hallucination arrives with and without
 * its full stop.
 */
const HALLUCINATIONS = [
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  'ありがとうございました',
  'おやすみなさい',
  'チャンネル登録よろしくお願いします',
  '最後までご視聴いただきありがとうございます',
];

/**
 * How the terms are said, and how they should be written.
 *
 * Longest first: `クロードコード` must win over `クロード` or it would be
 * rewritten to `Claudeコード`. Entries are added from observed transcripts,
 * never speculatively - a replacement that never fires is a rule nobody can
 * tell is wrong.
 */
const SPELLINGS: Array<[string, string]> = [
  ['クロードコード', 'Claude Code'],
  ['ノッシングホン', 'Nothing Phone'],
  ['コーデックス', 'Codex'],
  ['プルリクエスト', 'pull request'],
  ['イッシュー', 'issue'],
  ['ハーダー', 'herdr'],
  ['クロード', 'Claude'],
  ['イシュー', 'issue'],
];

/** Trailing punctuation only: what is inside the sentence is left alone. */
const TRAILING_PUNCTUATION = /[。、．，!！?？\s]+$/u;

export function isHallucination(text: string): boolean {
  const bare = text.trim().replace(TRAILING_PUNCTUATION, '');
  return HALLUCINATIONS.includes(bare);
}

/**
 * Repair one transcript. Returns an empty string for a hallucination, which
 * the route reports as "nothing was said" rather than as an error - the
 * request did happen and its quota was spent.
 */
export function applySttCorrections(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (isHallucination(trimmed)) return '';
  let out = trimmed;
  for (const [spoken, written] of SPELLINGS) {
    out = out.split(spoken).join(written);
  }
  return out;
}

/** The terms this module already fixes, so the prompt need not spend budget
 *  on them. Exported for the glossary's own test to assert against. */
export function correctedTerms(): string[] {
  return SPELLINGS.map(([, written]) => written);
}
