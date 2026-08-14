import { Hono } from 'hono';
import { z } from 'zod';
import {
  noteFallbackUsed,
  notePrimaryDown,
  notePrimaryUp,
  resolveSttDelivery,
  resolveSttEndpoint,
  type SttTarget,
  sttTargets,
} from '../services/stt-provider';
import {
  STT_MODELS,
  glassesSettingsView,
  resolveGroqApiKey,
  updateGlassesSettings,
} from '../services/glasses-settings';
import { applySttCorrections } from '../services/stt-corrections';
import {
  sttUsageService,
  pcmSeconds,
  readRateLimitHeaders,
  wavSeconds,
} from '../services/stt-usage';
import { notifyGlassesSettingsChanged } from '../services/glasses-relay';
import {
  glassesRecordingEnabled,
  listRecordingDays,
  readRecordingDay,
  recordSttRequest,
} from '../services/glasses-screen-recorder';

const glasses = new Hono();

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
 * `GET /api/glasses/stt-preview` reports. The key is resolved
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

  const format = c.req.query('format') || 'pcm';
  const sampleRate = Number(c.req.query('sampleRate')) || 16000;
  // `?session=` names the workspace being spoken to, so its own vocabulary
  // leads the prompt.
  // Content and destination are decided in one call (stt-provider.ts), and the
  // preview reads the same call - so "what was reported" and "what is sent"
  // cannot structurally disagree.
  const { attempts, preview: stt } = await resolveSttDelivery({
    sessionId: c.req.query('session'),
    lang: c.req.query('lang'),
    hasKey: !!apiKey,
  });

  if (attempts[0].target.needsKey && !apiKey) {
    return c.json({ error: 'No Groq API key: set one in the glasses settings or GROQ_API_KEY' }, 503);
  }

  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (raw.length === 0) {
    return c.json({ error: 'empty audio body' }, 400);
  }
  if (raw.length > MAX_AUDIO_BYTES) {
    return c.json({ error: 'audio too large' }, 413);
  }

  const wav = format === 'wav' ? raw : pcmToWav(raw, sampleRate);
  const audioSeconds = format === 'wav' ? wavSeconds(raw) : pcmSeconds(raw.length, sampleRate);

  // Copy into a freshly-allocated ArrayBuffer-backed view so the Blob part
  // types cleanly (Bun's Uint8Array is ArrayBufferLike, not ArrayBuffer).
  const wavBytes = new Uint8Array(wav.length);
  wavBytes.set(wav);

  const buildForm = (target: SttTarget): FormData => {
    const form = new FormData();
    form.append('file', new Blob([wavBytes.buffer], { type: 'audio/wav' }), 'audio.wav');
    // The one thing that differs per target is the model name - a custom
    // endpoint names its own.
    form.append('model', target.model);
    // A null language means send none, so Whisper detects it.
    if (stt.language) form.append('language', stt.language);
    form.append('response_format', 'json');
    // Greedy decoding keeps short commands fast and deterministic.
    form.append('temperature', '0');
    // What the speech is about. Without it the model has no reason to produce
    // the product's own coinages over ordinary words.
    if (stt.prompt) form.append('prompt', stt.prompt);
    return form;
  };

  /**
   * Write the request into the screen recording, beside the frame that will
   * show its result.
   *
   * Audio is never stored, so a model or a prompt can only be judged by
   * reading transcripts back - and a transcript that does not say which model
   * wrote it leaves the comparison resting on somebody's memory of when the
   * setting was last changed. Off unless the recording is on.
   *
   * One line per target tried. When the fallback stood in, the failed and the
   * successful attempt sit next to each other, so a transcript read back later
   * says where it actually came from.
   */
  const recordAttempt = (
    target: SttTarget,
    result: { ok: boolean; text?: string; raw?: string },
  ) => {
    recordSttRequest({
      model: target.model,
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

  let lastError = '';
  for (const [index, { target, isPrimary }] of attempts.entries()) {
    const isLast = index === attempts.length - 1;
    try {
      // The server's own idle timeout is 120s, and the wearer is watching
      // "Transcribing..." for all of it. Bound the leg we do not control well
      // inside that, so a stalled provider comes back as a 502 the glasses can
      // report rather than as the connection dying under them: 8 seconds of
      // audio transcribes in ~0.33s, so 60 is already far past slow.
      // With a fallback still waiting its turn, wait far less - a sleeping
      // host answers never, and spending the full timeout before escaping
      // defeats the point of having somewhere to escape to.
      const res = await fetch(target.url, {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: buildForm(target),
        signal: AbortSignal.timeout(isLast ? 60_000 : 8_000),
      });

      // Recorded before the status is acted on: a rejected request still
      // spends quota, and the headers on a 429 are the ones worth having. Not
      // awaited - the user is waiting on the transcript, not on a tally.
      // **Only attempts against the billed target are counted**: this tally
      // answers "how close to Groq's daily cap", and mixing in requests to a
      // custom endpoint would make the remaining headroom unreadable.
      if (target.billed) {
        void sttUsageService.record({
          audioSeconds,
          billedSeconds: audioSeconds,
          ok: res.ok,
          rateLimit: readRateLimitHeaders(res.headers, new Date().toISOString()),
        });
      }

      if (res.ok) {
        if (isPrimary) {
          notePrimaryUp();
        } else {
          noteFallbackUsed();
          console.warn(`[glasses/stt] using ${target.label} (primary unavailable)`);
        }
        // Parsing sits outside the send's try: inside it, one broken JSON
        // body would count the same request as both "succeeded" and "never
        // arrived", and roll the fallback judgement back with it. The send
        // itself has already been decided.
        const data = await res
          .json()
          .then((j) => j as { text?: string })
          .catch(() => null);
        if (!data) {
          lastError = `${target.label} unreadable response`;
          console.error(`[glasses/stt] ${lastError}`);
          recordAttempt(target, { ok: false });
          return c.json({ error: 'transcription failed' }, 502);
        }
        // Spelling the prompt cannot reach, and the sign-off Whisper writes into
        // silence. An emptied hallucination is reported as nothing said, not as an
        // error: the request happened and its quota was spent either way.
        const text = applySttCorrections(data.text || '');
        recordAttempt(target, { ok: true, text, raw: data.text || '' });
        return c.json({ text });
      }

      const detail = await res.text().catch(() => '');
      if (isPrimary && res.status >= 500) notePrimaryDown(target.url);
      lastError = `${target.label} ${res.status}`;
      console.error(`[glasses/stt] ${lastError}: ${detail.slice(0, 300)}`);
      recordAttempt(target, { ok: false });
      // A 4xx answers the same wherever it is sent - the request or the key is
      // wrong. The fallback is only for a target that is broken or absent.
      if (res.status < 500 || isLast) {
        return c.json({ error: `STT provider error (${res.status})` }, 502);
      }
    } catch (err) {
      // Never reached the target = a failure worth recording, and a billed one
      // only when the billed target was the one being tried (a custom server
      // asleep is not Groq usage). Zero seconds: nothing was transcribed.
      if (target.billed) void sttUsageService.record({ audioSeconds, billedSeconds: 0, ok: false });
      if (isPrimary) notePrimaryDown(target.url);
      lastError = `${target.label} unreachable`;
      console.error(`[glasses/stt] ${lastError}:`, err);
      recordAttempt(target, { ok: false });
      if (isLast) return c.json({ error: 'transcription failed' }, 500);
    }
  }
  console.error(`[glasses/stt] all targets failed (${lastError})`);
  return c.json({ error: 'transcription failed' }, 502);
});

/**
 * What would be sent with an utterance from this session, right now.
 *
 * `?session=<workspace id>` and `?lang=<code>` are the two things a real
 * transcription request carries besides the audio, so passing them here gives
 * the same answer that request would get - it is the same call. Without a
 * session, the answer is the one every session shares: the glossary.
 *
 * The Groq key is not in it. Nothing reads that back out, including this.
 */
glasses.get('/stt-preview', async (c) => {
  const { key } = await resolveGroqApiKey();
  const { preview } = await resolveSttDelivery({
    sessionId: c.req.query('session'),
    lang: c.req.query('lang'),
    hasKey: !!key,
  });
  return c.json(preview);
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
 * went.
 */
/**
 * The stored view plus where transcription is actually going.
 *
 * The endpoint block is composed here rather than in `glassesSettingsView`
 * because half the answer (the resolved targets) lives in `stt-provider`, and
 * `glasses-settings` importing it back would be a cycle. `destination` names
 * the target that would be hit right now, which is what the screen shows.
 */
async function settingsWithEndpoint() {
  const view = await glassesSettingsView();
  const endpoint = await resolveSttEndpoint();
  const targets = await sttTargets(view.sttModel);
  return {
    ...view,
    sttEndpoint: {
      url: endpoint.url ?? null,
      model: endpoint.model ?? null,
      provider: targets.provider,
      providerSource: targets.providerSource,
      // The stored intent, not whether a target exists today: the checkbox
      // must not appear to flip itself off just because no custom URL is set.
      fallback: targets.fallbackOn,
      source: endpoint.source,
      destination: targets.primary.label,
    },
  };
}

glasses.get('/settings', async (c) => {
  return c.json(await settingsWithEndpoint());
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
  // documented use was the word `off` typed into it.
  sttBias: z.enum(['on', 'off']).nullable().optional(),
  // A closed set: an unknown model is a 400 on every utterance, and the wearer
  // would see only "STT provider error".
  sttModel: z.enum(STT_MODELS).nullable().optional(),
  // Seconds before the glasses blank their panel. 0 = never, an hour at most.
  screenOffSeconds: z.number().int().min(0).max(3600).nullable().optional(),
  // A custom OpenAI-shaped transcription endpoint. http(s) only - audio goes
  // wherever this points, so a URL that is not one is refused here rather
  // than failing every utterance later.
  sttEndpointUrl: z
    .string()
    .max(500)
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'expected an http(s) URL' },
    )
    .nullable()
    .optional(),
  // Free text, not STT_MODELS: a custom server names its own models.
  sttEndpointModel: z.string().max(100).nullable().optional(),
  // Which transcriber speech goes to first, and whether the other one is the
  // escape when it fails.
  sttProvider: z.enum(['groq', 'custom']).nullable().optional(),
  sttFallback: z.enum(['on', 'off']).nullable().optional(),
});

/**
 * The screen-mirror recording, for the simulator's replay player.
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
  // Applied now on running glasses, not at their next poll: the first person
  // to edit the timeout from the phone read the slow pickup as a failed save.
  notifyGlassesSettingsChanged();
  return c.json(await settingsWithEndpoint());
});

export { glasses };
