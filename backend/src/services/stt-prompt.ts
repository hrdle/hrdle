import { envVar } from '../../../shared/identity';
import { type GlassesSettings, loadGlassesSettings } from './glasses-settings';
import { getAllSessionMetadata } from './session-metadata';

/**
 * Vocabulary bias for the glasses' speech-to-text.
 *
 * Whisper takes an initial prompt and treats it as transcript that came just
 * before, which is the supported way to tell it what words to expect. Left
 * empty it guesses from Japanese at large, where `herdr` is not a word and
 * `ペイン` is `ペイント` — every term this product is actually made of is a term
 * it has no reason to pick.
 *
 * The half that cannot be hardcoded is what is about to be said, and it is the
 * *session* that supplies it (#210). Workspace labels used to: they led the
 * prompt, on the reasoning that 「2脚ロボ開発」 is the user's own coinage and
 * unguessable. That held while a label was a name. It stopped being one — the
 * naming convention appends a status suffix (`— 作業中`, `— 完了済`) and agents
 * write the reason for an interruption into parentheses, so a label is now a
 * sentence written for a person reading a list. Measured on this machine on
 * 2026-08-07, thirteen of them spent 189 of the 190 characters and the glossary
 * arrived exactly one term deep: `タブ` got in, and `リリース`, `コミット`,
 * `リベース` and `ペイン` — the words actually reported as misheard — did not.
 *
 * Labels are gone from the prompt entirely rather than trimmed, because
 * trimming would only defer this: nothing stops a label growing again, and a
 * name written to be read is the wrong thing to ask for words that are about
 * to be spoken. What a session is about is now said deliberately, by whoever
 * knows — the agent in it, through `hrdle stt-prompt`, or a person through the
 * session's settings.
 */

/**
 * Terms this product's speech is made of, most-said first.
 *
 * The order is the order they survive in when the budget runs out, and it is
 * now measured rather than assumed. The glasses screen recording keeps the
 * voice screen's `[confirm]` frame, which is the transcript, so the eight days
 * to 2026-08-09 read back as 1030 utterances and say exactly which of these
 * words are spoken and which never were.
 *
 * Two groups were dropped on that evidence:
 *
 * - **Never said once in 1030 utterances**: `リベース`, `プルリクエスト`,
 *   `コンフリクト`, `リント`, `タブ`, `タグ`, `エラー`, `ログ`, `バグ`,
 *   `リファクタ`, `スクショ`, `Kimi`, `Grok`. Fourteen of the thirty-four
 *   terms were holding budget for speech that does not happen here. They can
 *   come back the moment a transcript shows them being missed.
 * - **Spelled, not heard**: `herdr`, the binary name, `issue`, `Codex` and
 *   `Claude Code`. The model was hearing these correctly all along and writing
 *   them in katakana - ハーダー ten times, イシュー twenty-three - which a
 *   prompt cannot change. `stt-corrections.ts` rewrites them afterwards, so
 *   the budget they were holding buys terms that are still being misheard.
 *
 * `ペイン` went with them, for a third reason: it is what the code calls a
 * pane and not what anyone says out loud. `パネル` came back eleven times and
 * `ペイン` never, so the glossary now carries the spoken word.
 */
const GLOSSARY = [
  'リリース',
  'ワークスペース',
  'セッション',
  'マージ',
  'エージェント',
  'テスト',
  'バージョン',
  'スマホ',
  'グラスアプリ',
  'スキル',
  'タスク',
  // What a pane is called out loud. `ペイン` is the code's word for it.
  'パネル',
  'グラス',
  'プッシュ',
  'デプロイ',
  'コミット',
  // Came back as 温泉式 - a real mishearing, and the kind of term a prompt
  // does help with, unlike the spellings above.
  '音声認識',
  'ブランチ',
  'ビルド',
  'フロントエンド',
  'バックエンド',
  'ターミナル',
];

/**
 * Whisper's prompt is capped at 224 tokens and Japanese runs close to a token
 * per character, so this is deliberately short of it. Overflow is not an error
 * — the provider keeps the tail — but relying on that would silently drop
 * whichever terms happen to sort first.
 */
const MAX_PROMPT_CHARS = 190;

/**
 * How much of it the contributed groups may take between them.
 *
 * Half is kept for the glossary no matter what else is set, because the failure
 * this file is named after was not "the wrong words were chosen" but "one group
 * filled the budget": thirteen workspace labels took 189 of 190 characters and
 * the glossary arrived one term deep. Labels are gone, but a session that is
 * told it may write 100 characters would do exactly the same thing, and the
 * words it would push out are the ones misheard every day in every session.
 */
const CONTRIBUTED_MAX_CHARS = Math.floor(MAX_PROMPT_CHARS / 2);

/**
 * Fold the vocabulary into one line of plausible preceding transcript.
 *
 * Three groups, in the order they are worth their characters, because the
 * budget does run out:
 *
 *  1. **This session's own words** (#166). The only group that knows what is
 *     about to be said rather than what is generally said here. A session
 *     about the G2 display and one about tax paperwork were biased identically
 *     before this, and neither got the terms it needed.
 *  2. **Shared words.** What the glasses' own settings screen adds — terms a
 *     person wants in every session's prompt. These outrank the glossary
 *     because someone typed them on purpose; the glossary is only our guess at
 *     the same thing.
 *  3. **Glossary.** Said constantly and misheard constantly, in every session.
 *
 * Neither of the first two can replace the glossary: between them they may
 * take half the budget, and the rest is the glossary's whatever they hold. It
 * is what is said every day everywhere, and a session that spent the whole
 * budget on its own vocabulary would start mishearing `リリース` again — which
 * is exactly what the removed workspace labels did (see the note at the top of
 * this file).
 *
 * Terms are taken whole: half a word biases nothing.
 */
export function buildSttPrompt(
  terms_: { session?: string[]; shared?: string[] } = {},
  glossary: string[] = GLOSSARY,
): string {
  const { session = [], shared = [] } = terms_;
  const terms: string[] = [];
  const seen = new Set<string>();
  let length = 0;

  const take = (candidates: string[], budget: number) => {
    for (const term of candidates) {
      const trimmed = term.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      // +1 for the separator this term would bring with it.
      const cost = trimmed.length + (terms.length > 0 ? 1 : 0);
      if (length + cost > budget) continue;
      seen.add(key);
      terms.push(trimmed);
      length += cost;
    }
  };

  take([...session, ...shared], CONTRIBUTED_MAX_CHARS);
  take(glossary, MAX_PROMPT_CHARS);

  return terms.join('、');
}

/**
 * A session's own prompt, as terms.
 *
 * Written as a phrase (「音声認識、Groq、ダッシュボード」 or a comma-separated
 * line), and split here rather than sent whole, so the budget can cut it
 * between terms instead of through one — half a word biases nothing.
 */
export function sessionPromptTerms(prompt: string | undefined): string[] {
  if (!prompt) return [];
  return prompt
    .split(/[、,\n]/)
    .map((term) => term.trim())
    .filter(Boolean);
}

/** This session's words, or none when the session has no prompt of its own. */
export async function sessionSttTerms(sessionId: string | undefined): Promise<string[]> {
  if (!sessionId) return [];
  const metadata = await getAllSessionMetadata().catch(
    () => ({}) as Awaited<ReturnType<typeof getAllSessionMetadata>>,
  );
  return sessionPromptTerms(metadata[sessionId]?.sttPrompt);
}

/** `HRDLE_STT_PROMPT`, composed so a rename cannot leave it behind again. */
const OVERRIDE_ENV = envVar('STT_PROMPT');

/**
 * The prompt to send with a transcription, or `undefined` to send none.
 *
 * `off` from either the saved setting or `HRDLE_STT_PROMPT` means no bias at
 * all, from any session. Any other value of the env var replaces the whole
 * line, which is how a composed prompt and a hand-written one are compared
 * without a rebuild — and it now outranks the saved setting rather than the
 * other way round, because the two no longer do the same job: one replaces,
 * the other contributes.
 *
 * The **saved setting no longer replaces anything** (#210). It did, and one
 * left over from a comparison in early August meant that for five days the
 * glasses were sent five words and none of the glossary, which took a "speech
 * recognition feels worse today" report and a code read to find. A setting that
 * silently disables everything else is the wrong shape for the one field
 * reachable from the device, so it is now a group inside the composition —
 * words added to every session's prompt — and replacing outright is left to the
 * env var, which does not outlive the process that set it.
 */
export async function sttPrompt(
  options: { sessionId?: string } = {},
): Promise<string | undefined> {
  const { sessionId } = options;
  const saved = (await loadGlassesSettings().catch((): GlassesSettings => ({}))).sttPrompt;
  const fromEnv = process.env[OVERRIDE_ENV];
  if (saved === 'off' || fromEnv === 'off') return undefined;
  if (fromEnv) return fromEnv;

  const prompt = buildSttPrompt({
    session: await sessionSttTerms(sessionId),
    shared: sessionPromptTerms(saved),
  });
  return prompt || undefined;
}
