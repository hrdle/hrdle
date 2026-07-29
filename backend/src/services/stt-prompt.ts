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
  'cchub',
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
 * The three groups are in the order they are worth their characters, because
 * the budget does run out — thirteen workspaces spend two thirds of it on
 * names alone:
 *
 *  1. **Titles.** A person named these, out loud, in Japanese. Nothing else
 *     can supply 「2脚ロボ開発」.
 *  2. **Glossary.** Said constantly and misheard constantly. These lost to the
 *     names in the first cut, which is exactly backwards: `リリース` is spoken
 *     ten times a day and `lifestyle-app-work-1` approximately never.
 *  3. **Labels.** herdr's own workspace names — directory-ish Latin text that
 *     the model was never going to render as a Japanese word anyway.
 *
 * Terms are taken whole: half a word biases nothing.
 */
export function buildSttPrompt(
  names: { titles?: string[]; labels?: string[] } | string[],
  glossary: string[] = GLOSSARY,
): string {
  const { titles = [], labels = [] } = Array.isArray(names) ? { titles: names } : names;
  const terms: string[] = [];
  const seen = new Set<string>();
  let length = 0;

  for (const term of [...titles, ...glossary, ...labels]) {
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

// The STT path is interactive — the glasses are showing "transcribing" while it
// runs — so it does not wait on herdr for a list that changes a few times a day.
const CACHE_TTL_MS = 60_000;
let cached: { prompt: string; at: number } | null = null;

/**
 * The prompt to send with a transcription, or `undefined` to send none.
 *
 * `CCHUB_STT_PROMPT=off` disables the bias, which is how the two are compared
 * without a rebuild; any other value is used verbatim.
 */
export async function sttPrompt(now = Date.now()): Promise<string | undefined> {
  const override = process.env.CCHUB_STT_PROMPT;
  if (override === 'off') return undefined;
  if (override) return override;

  if (cached && now - cached.at < CACHE_TTL_MS) return cached.prompt || undefined;
  const prompt = buildSttPrompt(await currentWorkspaceNames());
  cached = { prompt, at: now };
  return prompt || undefined;
}

/** Drop the memoized prompt (tests, and after a workspace is renamed). */
export function resetSttPromptCache(): void {
  cached = null;
}
