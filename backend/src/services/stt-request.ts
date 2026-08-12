/**
 * Everything a transcription request carries, resolved in one place.
 *
 * A request to Groq is four values - the key, the model, the language and the
 * vocabulary prompt - and each of them used to come from its own function with
 * its own precedence rules, assembled into a `FormData` by the route. The
 * request existed as one thing for the length of one `fetch` and then stopped
 * existing, so there was nobody to ask what a session is currently sending:
 * the answer meant reading four files and reassembling them in your head.
 *
 * Twice in one day that produced a wrong diagnosis - a per-session vocabulary
 * reported as broken when it was working, because the nearest thing that
 * looked like the sent value (`effectivePrompt` on the settings screen) was
 * not one.
 *
 * So: one function, and `GET /api/glasses/stt-preview` returning exactly what
 * it returns. The route below it decides nothing and only carries.
 *
 * **The API key is deliberately not here.** It is write-only - it goes in
 * through the settings API and never comes back out - and a preview endpoint
 * that included it would be the way it came back out.
 */

import {
  type SttModel,
  STT_PROMPT_ENV,
  resolveSttBias,
  resolveSttLang,
  resolveSttModel,
} from './glasses-settings';
import { type SttPromptComposition, composeSttPrompt, sessionSttVocabulary } from './stt-prompt';

/** Where the prompt came from, when there is one. */
export type SttPromptSource = 'composed' | 'env' | 'off';

/** What goes to Groq with one utterance, minus the key. */
export interface SttRequest {
  model: SttModel;
  modelSource: 'setting' | 'default';
  /**
   * The language field, or `null` to send none and let Whisper detect it.
   *
   * `null` is the whole of what `auto` means down here: sending a wrong
   * language is worse than sending none, because Whisper will transcribe
   * English as though it were the language named.
   */
  language: string | null;
  languageSource: 'request' | 'setting' | 'default';
  /** The prompt field, or `null` to send none. */
  prompt: string | null;
  promptSource: SttPromptSource;
  /**
   * How the line was arrived at - which group offered which term, what the
   * budget cut. `null` when the line was not composed here (`env`, `off`),
   * because then there is nothing to explain.
   */
  promptComposition: SttPromptComposition | null;
  /** The session whose words were used, when one was named. */
  sessionId: string | null;
}

/**
 * Resolve one transcription request.
 *
 * Precedence, all of it, in one readable block:
 *
 * - **model**: the saved setting, then the default
 * - **language**: `?lang=` on the request, then the saved setting, then `ja`.
 *   `auto` at any level means send none
 * - **prompt**: off (the switch, or `HRDLE_STT_PROMPT=off`) sends none;
 *   `HRDLE_STT_PROMPT` set to anything else replaces the line outright, which
 *   is how a hand-written prompt is compared against a composed one without a
 *   rebuild; otherwise it is composed from this session's words and the
 *   glossary - or from its words alone, with the whole budget, when the
 *   workspace has declined the glossary
 *
 * The env var replaces and the switch disables, and nothing a screen can save
 * does either. That asymmetry is deliberate: the one field reachable from the device
 * used to be able to silently disable everything else, and did, for five days.
 */
export async function resolveSttRequest(
  options: { sessionId?: string; lang?: string } = {},
): Promise<SttRequest> {
  const sessionId = options.sessionId?.trim() || null;

  const { model, source: modelSource } = await resolveSttModel();
  const { lang: savedLang, source: savedLangSource } = await resolveSttLang();
  const requested = options.lang?.trim();
  const lang = requested || savedLang;
  const languageSource = requested ? 'request' : savedLangSource;

  const { enabled: biasEnabled } = await resolveSttBias();
  const fromEnv = process.env[STT_PROMPT_ENV];

  let prompt: string | null = null;
  let promptSource: SttPromptSource = 'off';
  let promptComposition: SttPromptComposition | null = null;

  if (biasEnabled) {
    if (fromEnv) {
      prompt = fromEnv;
      promptSource = 'env';
    } else {
      const vocabulary = await sessionSttVocabulary(sessionId ?? undefined);
      promptComposition = composeSttPrompt(vocabulary.terms, {
        glossaryEnabled: vocabulary.glossaryEnabled,
      });
      // An empty composition still reads as `composed`: nothing was withheld,
      // there was simply nothing to say. The glossary makes that unlikely, but
      // a caller reading this should see the composition and not a bare `off`.
      prompt = promptComposition.prompt || null;
      promptSource = 'composed';
    }
  }

  return {
    model,
    modelSource,
    language: lang === 'auto' ? null : lang,
    languageSource,
    prompt,
    promptSource,
    promptComposition,
    sessionId,
  };
}
