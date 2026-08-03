import { IDENTITY, envVar } from '../../../shared/identity';
import { type GlassesSettings, loadGlassesSettings } from './glasses-settings';
import { listWorkspaces } from './herdr-client';
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
 * The names are the half that cannot be hardcoded: a workspace called
 * 「2脚ロボ開発」 is the user's own coinage, said out loud constantly, and
 * unguessable. This is why the prompt is built per request from live state
 * rather than shipped as a constant.
 */

/**
 * Terms this product's speech is made of, most-said first.
 *
 * These are ordinary-sounding words that the model has a competing reading for
 * — `リリース` and `リベース` are the ones that come back wrong most — so the
 * order here is the order they survive in when the budget runs out.
 */
const GLOSSARY = [
  'リリース',
  'マージ',
  'コミット',
  'リベース',
  'ブランチ',
  'プルリクエスト',
  'ペイン',
  'ワークスペース',
  'セッション',
  IDENTITY.binaryName,
  'herdr',
  'issue',
  'プッシュ',
  'コンフリクト',
  'ビルド',
  'デプロイ',
  'テスト',
  'リント',
  'タブ',
  'ターミナル',
  'Claude Code',
  'Codex',
  'グラス',
  'バージョン',
  'タグ',
  'エラー',
  'ログ',
  'バグ',
  'リファクタ',
  'スクショ',
  'フロントエンド',
  'バックエンド',
  'Kimi',
  'Grok',
];

/**
 * Whisper's prompt is capped at 224 tokens and Japanese runs close to a token
 * per character, so this is deliberately short of it. Overflow is not an error
 * — the provider keeps the tail — but relying on that would silently drop
 * whichever terms happen to sort first.
 */
const MAX_PROMPT_CHARS = 190;

/**
 * Fold the vocabulary into one line of plausible preceding transcript.
 *
 * The four groups are in the order they are worth their characters, because
 * the budget does run out — thirteen workspaces spend two thirds of it on
 * names alone:
 *
 *  1. **This session's own words** (#166). The only group that knows what is
 *     about to be said rather than what is generally said here. A session
 *     about the G2 display and one about tax paperwork were biased identically
 *     before this, and neither got the terms it needed.
 *  2. **Titles.** A person named these, out loud, in Japanese. Nothing else
 *     can supply 「2脚ロボ開発」.
 *  3. **Glossary.** Said constantly and misheard constantly. These lost to the
 *     names in the first cut, which is exactly backwards: `リリース` is spoken
 *     ten times a day and `lifestyle-app-work-1` approximately never.
 *  4. **Labels.** herdr's own workspace names — directory-ish Latin text that
 *     the model was never going to render as a Japanese word anyway.
 *
 * The session's words go *before* the glossary but do not replace it: the
 * glossary is what is said every day in every session, and a session that
 * spent the whole budget on its own vocabulary would start mishearing
 * `リリース` again.
 *
 * Terms are taken whole: half a word biases nothing.
 */
export function buildSttPrompt(
  names: { session?: string[]; titles?: string[]; labels?: string[] } | string[],
  glossary: string[] = GLOSSARY,
): string {
  const {
    session = [],
    titles = [],
    labels = [],
  } = Array.isArray(names) ? { titles: names } : names;
  const terms: string[] = [];
  const seen = new Set<string>();
  let length = 0;

  for (const term of [...session, ...titles, ...glossary, ...labels]) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    // +1 for the separator this term would bring with it.
    const cost = trimmed.length + (terms.length > 0 ? 1 : 0);
    if (length + cost > MAX_PROMPT_CHARS) continue;
    seen.add(key);
    terms.push(trimmed);
    length += cost;
  }

  return terms.join('、');
}

/**
 * Workspace names as spoken: the user's custom titles first, then herdr's own
 * labels. A title is chosen by a person and is usually the Japanese one; a
 * label is a directory-ish name that Whisper tends to get right anyway.
 */
export async function currentWorkspaceNames(): Promise<{ titles: string[]; labels: string[] }> {
  const [workspaces, metadata] = await Promise.all([
    listWorkspaces().catch(() => []),
    getAllSessionMetadata().catch(() => ({})),
  ]);
  return {
    titles: Object.values(metadata)
      .map((meta) => meta.title)
      .filter((title): title is string => !!title),
    labels: workspaces.map((w) => w.label).filter(Boolean),
  };
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

// The STT path is interactive — the glasses are showing "transcribing" while it
// runs — so it does not wait on herdr for a list that changes a few times a day.
const CACHE_TTL_MS = 60_000;
/**
 * The workspace names, not the finished prompt: since #166 the prompt also
 * depends on which session is speaking, and caching the composed line would
 * hand one session's vocabulary to the next one for up to a minute.
 * Composition itself is string work on a few dozen short terms.
 */
let cached: { names: { titles: string[]; labels: string[] }; at: number } | null = null;

/** `HRDLE_STT_PROMPT`, composed so a rename cannot leave it behind again. */
const OVERRIDE_ENV = envVar('STT_PROMPT');

/**
 * The prompt to send with a transcription, or `undefined` to send none.
 *
 * Three sources, most specific first: what the settings screen saved, then
 * `HRDLE_STT_PROMPT`, then the composed vocabulary. `off` from either override
 * disables the bias, which is how the two are compared without a rebuild; any
 * other value is used verbatim.
 *
 * The saved setting outranks the environment because it is the one a person can
 * change while wearing the glasses; the env var stays for A/B runs that should
 * not survive a restart.
 *
 * A session's own prompt (#166) is part of the *composed* line rather than a
 * fourth override: either override means "send exactly this", and a per-session
 * vocabulary is an addition to the composition, not a replacement for someone's
 * explicit choice. So an override still wins over it — including `off`, which
 * means no bias at all, from any session.
 */
export async function sttPrompt(
  options: { sessionId?: string; now?: number } = {},
): Promise<string | undefined> {
  const { sessionId, now = Date.now() } = options;
  const saved = (await loadGlassesSettings().catch((): GlassesSettings => ({}))).sttPrompt;
  const override = saved ?? process.env[OVERRIDE_ENV];
  if (override === 'off') return undefined;
  if (override) return override;

  const names =
    cached && now - cached.at < CACHE_TTL_MS ? cached.names : await currentWorkspaceNames();
  cached = { names, at: now };
  const prompt = buildSttPrompt({ ...names, session: await sessionSttTerms(sessionId) });
  return prompt || undefined;
}

/** Drop the memoized prompt (tests, and after a workspace is renamed). */
export function resetSttPromptCache(): void {
  cached = null;
}
