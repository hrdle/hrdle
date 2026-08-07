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

/** `auto` sends no language at all and lets Whisper detect it. */
export type SttLang = 'auto' | string;

export interface GlassesSettings {
  /** Groq API key. Overrides GROQ_API_KEY when set. */
  groqApiKey?: string;
  /** Language sent to Whisper, or `auto` to let it detect. */
  sttLang?: SttLang;
  /**
   * Words added to every session's vocabulary prompt, ahead of the glossary.
   * `off` sends no prompt at all. It used to *replace* the composed prompt,
   * which is #210: see the note on `sttPrompt()`.
   */
  sttPrompt?: string;
}

/** What a caller may see: everything except the key itself. */
export interface GlassesSettingsView {
  hasApiKey: boolean;
  apiKeySource: 'setting' | 'env' | 'none';
  sttLang: SttLang;
  sttLangSource: 'setting' | 'default';
  sttPrompt: string;
  /**
   * Where the line in `effectivePrompt` comes from. There is no `setting` any
   * more: what the screen saves is one group inside `composed`, not a
   * replacement for it (#210).
   */
  sttPromptSource: 'composed' | 'env' | 'off';
  /** The prompt that would be sent right now, so the editor can show it. */
  effectivePrompt: string;
}

export const DEFAULT_STT_LANG = 'ja';
const FILE_NAME = 'glasses-settings.json';
const PROMPT_ENV = envVar('STT_PROMPT');

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
    const parsed = JSON.parse(raw) as GlassesSettings;
    cache = {
      groqApiKey: typeof parsed.groqApiKey === 'string' ? parsed.groqApiKey : undefined,
      sttLang: typeof parsed.sttLang === 'string' ? parsed.sttLang : undefined,
      sttPrompt: typeof parsed.sttPrompt === 'string' ? parsed.sttPrompt : undefined,
    };
  } catch {
    cache = {};
  }
  return cache;
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
  sttPrompt?: string | null;
}): Promise<GlassesSettings> {
  return withLock(async () => {
    const current = await loadGlassesSettings();
    const next: GlassesSettings = { ...current };

    for (const key of ['groqApiKey', 'sttLang', 'sttPrompt'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      const trimmed = value === null ? '' : value.trim();
      if (trimmed === '') delete next[key];
      else next[key] = trimmed;
    }

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

/**
 * A view for the settings screen.
 *
 * `effectivePrompt` is the line that would be sent right now — the saved words
 * already folded into it — so the screen can show what typing here actually
 * produces rather than an empty box. It is passed in rather than composed here
 * because composing reads the session metadata, and that module is downstream
 * of this one.
 */
export async function glassesSettingsView(
  effectivePrompt: string | undefined,
): Promise<GlassesSettingsView> {
  const settings = await loadGlassesSettings();
  const { source: apiKeySource } = await resolveGroqApiKey();
  const { lang, source: sttLangSource } = await resolveSttLang();
  const envPrompt = process.env[PROMPT_ENV];

  const sttPromptSource =
    settings.sttPrompt === 'off' || envPrompt === 'off'
      ? 'off'
      : envPrompt
        ? 'env'
        : 'composed';

  return {
    hasApiKey: apiKeySource !== 'none',
    apiKeySource,
    sttLang: lang,
    sttLangSource,
    sttPrompt: settings.sttPrompt ?? '',
    sttPromptSource,
    effectivePrompt: effectivePrompt ?? '',
  };
}

/** Drop the memoized settings (tests, and after an external edit). */
export function resetGlassesSettingsCache(): void {
  cache = null;
}
