/**
 * Settings for the glasses' voice input, editable from the glasses app's own
 * web screens (the phone companion UI and the browser simulator).
 *
 * These used to be server-side only: `GROQ_API_KEY` in the service environment
 * and `HRDLE_STT_PROMPT` for the vocabulary bias. That is fine for a value set
 * once at install time, and wrong for the two that are per-use — the language,
 * and the prompt someone is tuning — because changing them meant editing a
 * systemd EnvironmentFile and restarting the server.
 *
 * The API key stays write-only: it can be set and cleared through the API, and
 * nothing reads it back out. What callers can see is whether one is set and
 * where it came from.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, createMutationLock, ensureDataDir, getDataDir } from '../utils/storage';
import { envVar } from '../../../shared/identity';
import { STT_MODELS, type SttModel } from '../../../shared/types';

/** `auto` sends no language at all and lets Whisper detect it. */
export type SttLang = 'auto' | string;

export interface GlassesSettings {
  /** Groq API key. Overrides GROQ_API_KEY when set. */
  groqApiKey?: string;
  /** Language sent to Whisper, or `auto` to let it detect. */
  sttLang?: SttLang;
  /**
   * Whether a vocabulary prompt is sent at all. Absent means it is.
   *
   * A switch rather than a field, because switching the bias off is something
   * that happens mid-conversation - "recognition is odd today, try it without"
   * - and the wearer has glasses on, not a shell. `HRDLE_STT_PROMPT=off` does
   * the same thing but needs a server restart.
   */
  sttBias?: 'on' | 'off';
  /** Transcription model. One of `STT_MODELS`. */
  sttModel?: string;
  /**
   * Seconds of ring silence before the glasses app blanks its panel.
   * `0` means never. Absent means the app's own default.
   *
   * Stored here rather than in the app so changing it is a settings-screen
   * edit, not an ehpk rebuild - the app fetches it on connect, on resume and
   * on a slow poll. Seconds rather than minutes because the screen takes a
   * typed number now, and a wearer asking for 90 should not be rounded.
   */
  screenOffSeconds?: number;
  /**
   * A transcription endpoint that is not Groq, in the OpenAI transcription
   * shape - a local Whisper, an mlx sidecar, a commercial compatible service.
   * Absent means Groq.
   *
   * `sttEndpointModel` travels with the URL as one unit: a custom server
   * names its own models (`whisper-1`), so pairing this store's Groq model
   * names with someone else's URL would 400 on every utterance.
   */
  sttEndpointUrl?: string;
  sttEndpointModel?: string;
  /**
   * Which of the two transcribers speech goes to first. Absent derives from
   * what is configured: a custom endpoint that exists is used, otherwise Groq.
   */
  sttProvider?: 'groq' | 'custom';
  /** Whether to switch to the other transcriber when the chosen one fails.
   *  Absent means yes - the safe default is speech that keeps working. */
  sttFallback?: 'on' | 'off';
}

/**
 * The models a caller may choose. Defined in `shared/types` so the dashboard
 * and the glasses app offer exactly the set this will accept.
 *
 * A closed set rather than a free string because the failure mode of a typo is
 * total: an unknown model is a 400 on every utterance, and the wearer sees
 * "STT provider error" with no hint that a settings field caused it.
 */
export { STT_MODELS, type SttModel } from '../../../shared/types';

/**
 * Default: `turbo`, which is what this ran on before the setting existed.
 *
 * The other one is the accuracy-first model and costs more per hour of audio;
 * which is better for this speech is a question about this user's voice and
 * vocabulary, so it is answered by switching and listening rather than by
 * picking here.
 */
export const DEFAULT_STT_MODEL: SttModel = 'whisper-large-v3-turbo';

/** An http(s) URL, or nothing. A file that holds anything else reads back as
 *  unset - a broken URL would fail every utterance with only "STT provider
 *  error" to show for it, same reasoning as the model list. */
function asEndpointUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `0` (never) up to an hour. Anything else reads back as unset. */
function asScreenOffSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3600
    ? value
    : undefined;
}

function asSttModel(value: unknown): SttModel | undefined {
  return typeof value === 'string' && (STT_MODELS as readonly string[]).includes(value)
    ? (value as SttModel)
    : undefined;
}

/**
 * What a caller may see: everything except the key itself.
 *
 * **Nothing here is the prompt that would be sent.** There used to be an
 * `effectivePrompt` field, and it was not one either - this screen has no
 * session, so it never carried the words of whoever is speaking. The name was
 * read as the sent value anyway and cost an afternoon diagnosing a
 * session-vocabulary bug that did not exist. Ask
 * `GET /api/glasses/stt-preview` instead: it answers with the object the
 * transcription itself uses.
 */
export interface GlassesSettingsView {
  hasApiKey: boolean;
  apiKeySource: 'setting' | 'env' | 'none';
  sttLang: SttLang;
  sttLangSource: 'setting' | 'default';
  /** Whether a vocabulary prompt is sent at all. */
  sttBias: boolean;
  /** `env` is `HRDLE_STT_PROMPT=off`, which this screen cannot switch back on. */
  sttBiasSource: 'setting' | 'env' | 'default';
  sttModel: SttModel;
  sttModelSource: 'setting' | 'default';
  /** Every model that may be chosen, so the screen need not hardcode them. */
  sttModels: readonly SttModel[];
  /** Seconds before the glasses blank their panel; `0` = never. */
  screenOffSeconds: number;
  screenOffSecondsSource: 'setting' | 'default';
}

export const DEFAULT_STT_LANG = 'ja';

/**
 * `0`: the screen stays on unless someone chooses otherwise. The app never
 * slept before this feature existed, and a default is not the place to change
 * behavior under an existing wearer - auto-off is opt-in from the settings
 * screen. Matches the app's own built-in (SCREEN_OFF_IDLE_MS in glasses/src):
 * an app that never fetched settings and a server that never stored any must
 * agree, or the first settings save silently changes the wearer's timeout.
 */
export const DEFAULT_SCREEN_OFF_SECONDS = 0;

const FILE_NAME = 'glasses-settings.json';

/**
 * `HRDLE_STT_PROMPT`, composed so a rename cannot leave it behind again.
 *
 * `off` disables the bias; anything else replaces the whole line. Exported
 * because the resolver applies it and this module reports it.
 */
export const STT_PROMPT_ENV = envVar('STT_PROMPT');

const withLock = createMutationLock();
let cache: GlassesSettings | null = null;

function settingsPath(): string {
  return join(getDataDir(), FILE_NAME);
}

/** Load the stored settings. A missing or unreadable file means "none set". */
export async function loadGlassesSettings(): Promise<GlassesSettings> {
  if (cache) return cache;
  try {
    const raw = await readFile(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as GlassesSettings & { sttPrompt?: unknown };
    cache = {
      groqApiKey: typeof parsed.groqApiKey === 'string' ? parsed.groqApiKey : undefined,
      sttLang: typeof parsed.sttLang === 'string' ? parsed.sttLang : undefined,
      sttBias: readBias(parsed),
      // A model that is no longer offered reads back as unset rather than as
      // itself: every transcription would 400 otherwise, and the file is the
      // one place nobody looks when speech stops working.
      sttModel: asSttModel(parsed.sttModel),
      screenOffSeconds: asScreenOffSeconds(parsed.screenOffSeconds),
      sttEndpointUrl: asEndpointUrl(parsed.sttEndpointUrl),
      sttEndpointModel:
        typeof parsed.sttEndpointModel === 'string' ? parsed.sttEndpointModel : undefined,
      sttProvider:
        parsed.sttProvider === 'groq' || parsed.sttProvider === 'custom'
          ? parsed.sttProvider
          : undefined,
      sttFallback:
        parsed.sttFallback === 'on' || parsed.sttFallback === 'off'
          ? parsed.sttFallback
          : undefined,
    };
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * The switch, reading a file that may predate it.
 *
 * `sttPrompt` was the shared-words field and is gone. Its words are
 * dropped - they were a group in the prompt and there is no group for them any
 * more - but the one value that meant something other than words is carried
 * over: `off` disabled the bias entirely, and somebody who switched it off
 * deliberately should not find it switched back on by an update.
 */
function readBias(parsed: { sttBias?: unknown; sttPrompt?: unknown }): 'on' | 'off' | undefined {
  if (parsed.sttBias === 'on' || parsed.sttBias === 'off') return parsed.sttBias;
  if (parsed.sttPrompt === 'off') return 'off';
  return undefined;
}

/**
 * Merge a patch into the stored settings.
 *
 * `null` on a field clears it, which is how the UI hands back "use the
 * environment / the composed prompt again" as distinct from "leave unchanged"
 * (`undefined`).
 */
export async function updateGlassesSettings(patch: {
  groqApiKey?: string | null;
  sttLang?: string | null;
  sttBias?: 'on' | 'off' | null;
  sttModel?: string | null;
  screenOffSeconds?: number | null;
  sttEndpointUrl?: string | null;
  sttEndpointModel?: string | null;
  sttProvider?: 'groq' | 'custom' | null;
  sttFallback?: 'on' | 'off' | null;
}): Promise<GlassesSettings> {
  return withLock(async () => {
    const current = await loadGlassesSettings();
    const next: GlassesSettings = { ...current };

    for (const key of ['groqApiKey', 'sttLang', 'sttModel', 'sttEndpointUrl', 'sttEndpointModel'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      const trimmed = value === null ? '' : value.trim();
      if (trimmed === '') delete next[key];
      else next[key] = trimmed;
    }

    if (patch.sttBias !== undefined) {
      if (patch.sttBias === null) delete next.sttBias;
      else next.sttBias = patch.sttBias;
    }

    if (patch.screenOffSeconds !== undefined) {
      const seconds = patch.screenOffSeconds === null ? undefined : asScreenOffSeconds(patch.screenOffSeconds);
      if (seconds === undefined) delete next.screenOffSeconds;
      else next.screenOffSeconds = seconds;
    }

    if (patch.sttProvider !== undefined) {
      if (patch.sttProvider === null) delete next.sttProvider;
      else next.sttProvider = patch.sttProvider;
    }

    if (patch.sttFallback !== undefined) {
      if (patch.sttFallback === null) delete next.sttFallback;
      else next.sttFallback = patch.sttFallback;
    }

    // The URL was validated at the route; a value that still fails to parse
    // here is dropped rather than stored, for the same reason a retired model
    // is - a stored value must never be one every utterance fails on.
    if (next.sttEndpointUrl && !asEndpointUrl(next.sttEndpointUrl)) delete next.sttEndpointUrl;


    await ensureDataDir();
    // 0600: this file holds an API key.
    await atomicWriteFile(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, 0o600);
    cache = next;
    return next;
  });
}

/** The Groq key actually used, and where it came from. */
export async function resolveGroqApiKey(): Promise<{
  key?: string;
  source: 'setting' | 'env' | 'none';
}> {
  const stored = (await loadGlassesSettings()).groqApiKey;
  if (stored) return { key: stored, source: 'setting' };
  const fromEnv = process.env.GROQ_API_KEY;
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return { source: 'none' };
}

/** The language actually sent, and where it came from. */
export async function resolveSttLang(): Promise<{ lang: SttLang; source: 'setting' | 'default' }> {
  const stored = (await loadGlassesSettings()).sttLang;
  if (stored) return { lang: stored, source: 'setting' };
  return { lang: DEFAULT_STT_LANG, source: 'default' };
}

/** The transcription model actually used, and where it came from. */
export async function resolveSttModel(): Promise<{
  model: SttModel;
  source: 'setting' | 'default';
}> {
  const stored = asSttModel((await loadGlassesSettings()).sttModel);
  if (stored) return { model: stored, source: 'setting' };
  return { model: DEFAULT_STT_MODEL, source: 'default' };
}

/**
 * Whether a vocabulary prompt is sent at all, and who said so.
 *
 * The environment can only switch it off, never on: `HRDLE_STT_PROMPT=off` is
 * a decision made at the process level, and a screen quietly overriding it
 * would be the same shape of surprise in the other direction. The
 * screen is told which of the two it is looking at.
 */
export async function resolveSttBias(): Promise<{
  enabled: boolean;
  source: 'setting' | 'env' | 'default';
}> {
  if (process.env[STT_PROMPT_ENV] === 'off') return { enabled: false, source: 'env' };
  const stored = (await loadGlassesSettings()).sttBias;
  if (stored) return { enabled: stored === 'on', source: 'setting' };
  return { enabled: true, source: 'default' };
}

/**
 * A view for the settings screen: what is *stored*, and where each value comes
 * from when nothing is stored.
 *
 * What would actually be sent is a different question with a different answer
 * per session, and it is `resolveSttRequest` that answers it.
 */
export async function glassesSettingsView(): Promise<GlassesSettingsView> {
  const { source: apiKeySource } = await resolveGroqApiKey();
  const { lang, source: sttLangSource } = await resolveSttLang();
  const { model: sttModel, source: sttModelSource } = await resolveSttModel();
  const { enabled: sttBias, source: sttBiasSource } = await resolveSttBias();
  const storedScreenOff = (await loadGlassesSettings()).screenOffSeconds;

  return {
    hasApiKey: apiKeySource !== 'none',
    apiKeySource,
    sttLang: lang,
    sttLangSource,
    sttBias,
    sttBiasSource,
    sttModel,
    sttModelSource,
    sttModels: STT_MODELS,
    screenOffSeconds: storedScreenOff ?? DEFAULT_SCREEN_OFF_SECONDS,
    screenOffSecondsSource: storedScreenOff === undefined ? 'default' : 'setting',
  };
}

/** Drop the memoized settings (tests, and after an external edit). */
export function resetGlassesSettingsCache(): void {
  cache = null;
}
