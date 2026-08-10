import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSttRequest } from '../services/stt-request';
import {
  STT_MODELS,
  glassesSettingsView,
  resolveGroqApiKey,
  updateGlassesSettings,
} from '../services/glasses-settings';
import { applySttCorrections } from '../services/stt-corrections';
import {
  groqSttUsageService,
  pcmSeconds,
  readRateLimitHeaders,
  wavSeconds,
} from '../services/groq-stt-usage';
import {
  glassesRecordingEnabled,
  listRecordingDays,
  readRecordingDay,
  recordSttRequest,
} from '../services/glasses-screen-recorder';

const glasses = new Hono();

const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
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
 * POST /api/glasses/stt — transcribe audio via Groq Whisper.
 *
 * Body: raw audio bytes (application/octet-stream).
 *   - Default: little-endian 16-bit mono PCM at `?sampleRate=` (default 16000);
 *     the server wraps it into a WAV before forwarding to Groq.
 *   - `?format=wav`: body is already a complete WAV/other audio file — forwarded as-is.
 * Query: `?sampleRate=<n>` (PCM only), `?lang=<code>`, `?session=<workspace id>`.
 * Response: `{ text }`.
 *
 * **This handler decides nothing about what is sent.** The model, the language
 * and the vocabulary prompt come from one call to `resolveSttRequest()`, which
 * holds every precedence rule between them and is what
 * `GET /api/glasses/stt-preview` reports (#255). The key is resolved
 * separately, and only here, because it is write-only and must not be
 * reachable through a preview.
 *
 * What comes back is repaired by `stt-corrections.ts` before it is returned:
 * the prompt biases what is heard and has no say over how it is spelled.
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
  // `?session=` names the workspace being spoken to, so its own vocabulary
  // leads the prompt (#166).
  const stt = await resolveSttRequest({
    sessionId: c.req.query('session'),
    lang: c.req.query('lang'),
  });

  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (raw.length === 0) {
    return c.json({ error: 'empty audio body' }, 400);
  }
  if (raw.length > MAX_AUDIO_BYTES) {
    return c.json({ error: 'audio too large' }, 413);
  }

  const wav = format === 'wav' ? raw : pcmToWav(raw, sampleRate);
  const audioSeconds = format === 'wav' ? wavSeconds(raw) : pcmSeconds(raw.length, sampleRate);

  /**
   * Write the request into the screen recording, beside the frame that will
   * show its result.
   *
   * Audio is never stored, so a model or a prompt can only be judged by
   * reading transcripts back - and a transcript that does not say which model
   * wrote it leaves the comparison resting on somebody's memory of when the
   * setting was last changed. Off unless the recording is on.
   */
  const recordAttempt = (result: { ok: boolean; text?: string; raw?: string }) => {
    recordSttRequest({
      model: stt.model,
      language: stt.language,
      prompt: stt.prompt,
      promptSource: stt.promptSource,
      sessionId: stt.sessionId,
      audioSeconds,
      ok: result.ok,
      text: result.text,
      // Only when the correction table actually changed something - otherwise
      // it is the same sentence stored twice.
      raw: result.raw !== result.text ? result.raw : undefined,
    });
  };

  try {
    // Copy into a freshly-allocated ArrayBuffer-backed view so the Blob part
    // types cleanly (Bun's Uint8Array is ArrayBufferLike, not ArrayBuffer).
    const wavBytes = new Uint8Array(wav.length);
    wavBytes.set(wav);

    const form = new FormData();
    form.append('file', new Blob([wavBytes.buffer], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', stt.model);
    // A null language means send none, so Whisper detects it.
    if (stt.language) form.append('language', stt.language);
    form.append('response_format', 'json');
    // Greedy decoding keeps short commands fast and deterministic.
    form.append('temperature', '0');
    // What the speech is about. Without it the model has no reason to produce
    // `パネル` over `ペイント`, and reaches for the ordinary Japanese word.
    if (stt.prompt) form.append('prompt', stt.prompt);

    // The server's own idle timeout is 120s (#209), and the wearer is watching
    // "Transcribing..." for all of it. Bound the leg we do not control well
    // inside that, so a stalled provider comes back as a 502 the glasses can
    // report rather than as the connection dying under them: 8 seconds of
    // audio transcribes in ~0.33s, so 60 is already far past slow.
    const res = await fetch(GROQ_STT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    // Recorded before the status is acted on: a rejected request still spends
    // quota, and the headers on a 429 are the ones worth having. Not awaited -
    // the user is waiting on the transcript, not on a tally.
    void groqSttUsageService.record({
      audioSeconds,
      ok: res.ok,
      rateLimit: readRateLimitHeaders(res.headers, new Date().toISOString()),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[glasses/stt] Groq ${res.status}: ${detail.slice(0, 300)}`);
      recordAttempt({ ok: false });
      return c.json({ error: `STT provider error (${res.status})` }, 502);
    }

    const data = (await res.json()) as { text?: string };
    // Spelling the prompt cannot reach, and the sign-off Whisper writes into
    // silence. An emptied hallucination is reported as nothing said, not as an
    // error: the request happened and its quota was spent either way.
    const text = applySttCorrections(data.text || '');
    recordAttempt({ ok: true, text, raw: data.text || '' });
    return c.json({ text });
  } catch (err) {
    console.error('[glasses/stt] transcription failed:', err);
    recordAttempt({ ok: false });
    return c.json({ error: 'transcription failed' }, 500);
  }
});

/**
 * What would be sent with an utterance from this session, right now (#255).
 *
 * `?session=<workspace id>` and `?lang=<code>` are the two things a real
 * transcription request carries besides the audio, so passing them here gives
 * the same answer that request would get - it is the same call. Without a
 * session, the answer is the one every session shares: the glossary.
 *
 * The Groq key is not in it. Nothing reads that back out, including this.
 */
glasses.get('/stt-preview', async (c) => {
  return c.json(
    await resolveSttRequest({ sessionId: c.req.query('session'), lang: c.req.query('lang') }),
  );
});

/**
 * The settings the glasses app's own web screens edit.
 *
 * GET returns everything except the key itself — whether one is set, and which
 * source each value comes from, so the screen can say "this is coming from the
 * environment" rather than showing a box that looks empty but is not.
 *
 * It reports what is *stored*. For what would be sent, the screen asks
 * `/stt-preview`: this endpoint has no session and so could never answer that
 * question, and the field that looked as though it did was where an afternoon
 * went (#255).
 */
glasses.get('/settings', async (c) => {
  return c.json(await glassesSettingsView());
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
  // The vocabulary bias, as a switch. It replaced a free-text field whose one
  // documented use was the word `off` typed into it (#255).
  sttBias: z.enum(['on', 'off']).nullable().optional(),
  // A closed set: an unknown model is a 400 on every utterance, and the wearer
  // would see only "STT provider error".
  sttModel: z.enum(STT_MODELS).nullable().optional(),
});

/**
 * The screen-mirror recording (#127), for the simulator's replay player.
 *
 * Recorded frames are this user's own prompts and notification text, so both
 * endpoints sit inside the auth glob (unlike `/relay*`). Reading works even
 * with recording switched off — old footage stays replayable.
 */
glasses.get('/recording', async (c) => {
  return c.json({ enabled: glassesRecordingEnabled(), days: await listRecordingDays() });
});

glasses.get('/recording/:day', async (c) => {
  const day = c.req.param('day');
  // readRecordingDay validates the YYYY-MM-DD shape itself (its regex is the
  // path-traversal guard), so a bad param and a missing day both land here.
  const lines = await readRecordingDay(day);
  if (lines === null) return c.json({ error: 'no recording for that day' }, 404);
  return c.json({ day, lines });
});

glasses.put('/settings', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = GlassesSettingsPatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid settings' }, 400);
  }
  await updateGlassesSettings(parsed.data);
  return c.json(await glassesSettingsView());
});

export { glasses };
