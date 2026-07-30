import { Hono } from 'hono';
import { z } from 'zod';
import { buildSttPrompt, currentWorkspaceNames, sttPrompt } from '../services/stt-prompt';
import {
  glassesSettingsView,
  resolveGroqApiKey,
  resolveSttLang,
  updateGlassesSettings,
} from '../services/glasses-settings';

const glasses = new Hono();

const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Groq's file limit

/**
 * Wrap raw little-endian 16-bit PCM into a minimal WAV container so Groq's
 * transcription endpoint (which wants a real audio file) accepts it.
 */
function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerSample = 16): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/**
 * POST /api/glasses/stt — transcribe audio via Groq whisper-large-v3-turbo.
 *
 * Body: raw audio bytes (application/octet-stream).
 *   - Default: little-endian 16-bit mono PCM at `?sampleRate=` (default 16000);
 *     the server wraps it into a WAV before forwarding to Groq.
 *   - `?format=wav`: body is already a complete WAV/other audio file — forwarded as-is.
 * Query: `?sampleRate=<n>` (PCM only), `?lang=<code>`.
 * Response: `{ text }`.
 *
 * The key, the language and the prompt come from the settings the glasses app's
 * own web screens write (`glasses-settings.ts`), each falling back to what the
 * server was configured with: `GROQ_API_KEY`, `ja`, and the vocabulary prompt
 * composed from live workspace names (`stt-prompt.ts`). A `?lang=` on the
 * request still wins, and `auto` sends no language so Whisper detects it.
 *
 * Used by the G2 glasses voice-input flow (SDK gives raw mic PCM only, so STT
 * is done server-side; the key never leaves this host).
 */
glasses.post('/stt', async (c) => {
  const { key: apiKey } = await resolveGroqApiKey();
  if (!apiKey) {
    return c.json({ error: 'No Groq API key: set one in the glasses settings or GROQ_API_KEY' }, 503);
  }

  const format = c.req.query('format') || 'pcm';
  const sampleRate = Number(c.req.query('sampleRate')) || 16000;
  const lang = c.req.query('lang') || (await resolveSttLang()).lang;

  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (raw.length === 0) {
    return c.json({ error: 'empty audio body' }, 400);
  }
  if (raw.length > MAX_AUDIO_BYTES) {
    return c.json({ error: 'audio too large' }, 413);
  }

  const wav = format === 'wav' ? raw : pcmToWav(raw, sampleRate);

  try {
    // Copy into a freshly-allocated ArrayBuffer-backed view so the Blob part
    // types cleanly (Bun's Uint8Array is ArrayBufferLike, not ArrayBuffer).
    const wavBytes = new Uint8Array(wav.length);
    wavBytes.set(wav);

    const form = new FormData();
    form.append('file', new Blob([wavBytes.buffer], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', GROQ_MODEL);
    // `auto` means send nothing: Whisper detects the language itself. Sending a
    // wrong one is worse than sending none - it transcribes English as though
    // it were the language named.
    if (lang && lang !== 'auto') form.append('language', lang);
    form.append('response_format', 'json');
    // Greedy decoding keeps short commands fast and deterministic.
    form.append('temperature', '0');
    // What the speech is about: product terms and the user's own workspace
    // names. Without it the model has no reason to produce `herdr` or
    // 「2脚ロボ開発」, and reaches for the ordinary Japanese word instead.
    const prompt = await sttPrompt();
    if (prompt) form.append('prompt', prompt);

    const res = await fetch(GROQ_STT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[glasses/stt] Groq ${res.status}: ${detail.slice(0, 300)}`);
      return c.json({ error: `STT provider error (${res.status})` }, 502);
    }

    const data = (await res.json()) as { text?: string };
    const text = (data.text || '').trim();
    return c.json({ text });
  } catch (err) {
    console.error('[glasses/stt] transcription failed:', err);
    return c.json({ error: 'transcription failed' }, 500);
  }
});

/**
 * The settings the glasses app's own web screens edit.
 *
 * GET returns everything except the key itself — whether one is set, and which
 * source each value comes from, so the screen can say "this is coming from the
 * environment" rather than showing a box that looks empty but is not.
 */
glasses.get('/settings', async (c) => {
  const composed = buildSttPrompt(await currentWorkspaceNames());
  return c.json(await glassesSettingsView(composed));
});

/**
 * PUT accepts a patch. `null` clears a field (back to the environment, or to
 * the composed prompt); omitting it leaves that field alone. The key is
 * write-only: it goes in through here and never comes back out.
 */
const GlassesSettingsPatchSchema = z.object({
  groqApiKey: z.string().max(500).nullable().optional(),
  // Whisper takes ISO-639-1; `auto` is ours and means "send none".
  sttLang: z
    .string()
    .regex(/^(auto|[a-z]{2}(-[A-Za-z]{2,4})?)$/, 'expected `auto` or a language code such as `en`')
    .nullable()
    .optional(),
  sttPrompt: z.string().max(2000).nullable().optional(),
});

glasses.put('/settings', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = GlassesSettingsPatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid settings' }, 400);
  }
  await updateGlassesSettings(parsed.data);
  const composed = buildSttPrompt(await currentWorkspaceNames());
  return c.json(await glassesSettingsView(composed));
});

export { glasses };
