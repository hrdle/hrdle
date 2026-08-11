/**
 * Records the glasses screen mirror to disk for the public-release demo video
 *.
 *
 * The mirror is text state, not pixels: each `glasses-screen` frame is the
 * three container strings the G2 just drew (well under 5KB), published over
 * the mux WebSocket and otherwise held only in memory. This recorder is an
 * internal subscriber at the publish point — it sees every frame whether or
 * not a human viewer has the mirror open — and appends them to one JSONL file
 * per day under the data directory. A month of frames is a few MB.
 *
 * Recording is opt-in via HRDLE_GLASSES_RECORD (off by default). It captures
 * this user's own prompts and notification text, so it must never be an
 * always-on capture for every install; selecting footage for public use is a
 * manual review step afterward.
 *
 * Replay tooling (feeding a recorded range back through the simulator's
 * renderer) comes later, once there is real data to test it against.
 */

import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from '../cli';
import { envVar } from '../../../shared/identity';
import type {
  ClientFocus,
  GlassesInput,
  GlassesScreen,
  RecordedSttRequest,
} from '../../../shared/types';
import { getDataDir } from '../utils/storage';

const RECORD_ENV = envVar('GLASSES_RECORD');
const DIR_NAME = 'glasses-screen-recording';

/** Rolling window. A year: the recording doubles as a debugging trail
 *  (what was on the glasses when the app died), not just demo footage,
 *  and a year of text frames is tens of MB. */
const RETENTION_DAYS = 365;

/** A recorded line: a frame as published plus the server's own arrival
 *  clock, a gap marker written when the publisher disconnects (so replay can
 *  tell "screen unchanged for an hour" from "glasses were off for an hour"),
 *  or a ring gesture so replay shows the wearer driving. `receivedAt`
 *  guards the timeline against a skewed device clock — and the
 *  `at`/`receivedAt` gap itself is diagnostic (clock drift, WebView
 *  background throttling). The three shapes are discriminated by their own
 *  keys, so old recordings read back unchanged. */
/**
 * The server build that wrote the line.
 *
 * Stamped on every shape, including the ones that carry no frame: a recording
 * is read later to decide whether something is fixed, and half of what gets
 * fixed lives on this side. The app's own build travels on the frame
 * (`GlassesScreen.app`), so a frame says which pair drew it and a gap says
 * which server saw the glasses leave.
 */
type ServerStamp = { server?: string };

export type RecordedGlassesLine =
  | (GlassesScreen & { receivedAt: number } & ServerStamp)
  | ({ gap: true; at: number } & ServerStamp)
  | ({ input: GlassesInput['kind']; at: number; receivedAt: number } & ServerStamp)
  | ({
      /** The transcription request behind the confirm frame that follows. */
      stt: RecordedSttRequest;
      /** Server clock. This shape is the server speaking, so there is no
       *  device stamp to reconcile it against. */
      at: number;
    } & ServerStamp)
  | ({
      /** Session the focus election picked, `null` when it cleared. */
      focus: string | null;
      deviceType?: string;
      /** When the focus was claimed — can predate the surrounding lines,
       *  since a claim outlives the moment it was made. Order by receivedAt. */
      at: number;
      receivedAt: number;
    } & ServerStamp);

/** Local date stamp — the user reviews footage in their own timezone. */
function dayStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export function glassesRecordingEnabled(): boolean {
  const value = process.env[RECORD_ENV];
  return value === '1' || value === 'true';
}

function recordingDir(): string {
  return join(getDataDir(), DIR_NAME);
}

// All disk work is serialized on one chain so lines never interleave and a
// prune never races an append. Errors are swallowed after a warn: recording
// is an observer, and a full disk must not take the mirror down with it.
let queue: Promise<void> = Promise.resolve();
let announced = false;
let lastFrameKey: string | null = null;
/** False until a frame or gesture lands, and again after each gap: a gap
 *  marker is only worth writing when something showed life since the last
 *  one, and never before anything was recorded at all. */
let recordedSinceGap = false;
let lastPrunedDay: string | null = null;

function enqueue(work: () => Promise<void>): void {
  queue = queue
    .then(work)
    .catch((err) => console.warn('[glasses-recorder]', err instanceof Error ? err.message : err));
}

async function pruneOldFiles(today: string): Promise<void> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await readdir(recordingDir());
  } catch {
    return; // nothing recorded yet
  }
  for (const name of entries) {
    const match = DAY_FILE_RE.exec(name);
    if (!match) continue;
    const fileDay = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (fileDay.getTime() < cutoff) {
      await unlink(join(recordingDir(), name)).catch(() => undefined);
      console.log(`[glasses-recorder] pruned ${name} (older than ${RETENTION_DAYS} days)`);
    }
  }
  lastPrunedDay = today;
}

async function appendLine(line: RecordedGlassesLine, day: string): Promise<void> {
  await mkdir(recordingDir(), { recursive: true });
  if (lastPrunedDay !== day) await pruneOldFiles(day);
  await appendFile(join(recordingDir(), `${day}.jsonl`), `${JSON.stringify(line)}\n`);
}

/**
 * Record one mirror event. `null` means the publisher went away (the same
 * signal viewers get) and is written as a gap marker — at most one in a row,
 * since consecutive gaps carry no more information than the first.
 *
 * Identical consecutive frames are skipped: the state on the wearer's face
 * did not change, so replay loses nothing and the file stays a log of
 * transitions rather than a heartbeat.
 */
export function recordGlassesScreen(screen: GlassesScreen | null): void {
  if (!glassesRecordingEnabled()) return;
  if (!announced) {
    announced = true;
    console.log(`[glasses-recorder] recording to ${recordingDir()} (${RECORD_ENV} is set)`);
  }

  if (screen === null) {
    if (!recordedSinceGap) return;
    lastFrameKey = null;
    recordedSinceGap = false;
    const marker: RecordedGlassesLine = { gap: true, at: Date.now(), server: VERSION };
    enqueue(() => appendLine(marker, dayStamp(marker.at)));
    return;
  }

  const key = JSON.stringify([screen.mode, screen.session?.id, screen.header, screen.notice, screen.body, screen.footer]);
  if (key === lastFrameKey) return;
  lastFrameKey = key;
  // The glasses just proved themselves alive; the focus that was parked while
  // they were off becomes this frame's context and must precede it on disk.
  flushPendingFocus();
  recordedSinceGap = true;
  // Stamp arrival now, not when the queued write runs. File choice follows
  // the server clock too: a device clock a day off must not scatter one
  // evening across two files.
  const line: RecordedGlassesLine = { ...screen, receivedAt: Date.now(), server: VERSION };
  enqueue(() => appendLine(line, dayStamp(line.receivedAt)));
}

/**
 * Record one ring gesture. No dedup — every gesture happened — and no
 * effect on frame dedup: the gesture's consequence arrives as its own frame.
 * A gesture proves the device is alive, so the next disconnect writes a fresh
 * gap marker even if no frame made it through in between.
 */
export function recordGlassesInput(input: GlassesInput): void {
  if (!glassesRecordingEnabled()) return;
  if (!announced) {
    announced = true;
    console.log(`[glasses-recorder] recording to ${recordingDir()} (${RECORD_ENV} is set)`);
  }
  // A gesture is the device speaking, same as a frame: whatever focus was
  // parked while the glasses were off belongs on disk before it.
  flushPendingFocus();
  recordedSinceGap = true;
  const line: RecordedGlassesLine = { input: input.kind, at: input.at, receivedAt: Date.now(), server: VERSION };
  enqueue(() => appendLine(line, dayStamp(line.receivedAt)));
}

/**
 * Record one transcription request, with what came back.
 *
 * Written just before the confirm frame that shows the result, so a recording
 * says which model and which vocabulary prompt produced the words on the next
 * line. Nothing else can: audio is not stored, so an A/B between models is
 * only ever a comparison of transcripts, and until this the transcripts did
 * not say which model wrote them - the answer lived in somebody's memory of
 * when the setting was last changed.
 *
 * No dedup: every utterance happened, and two identical sentences a minute
 * apart are two data points. It deliberately does **not** touch the gap and
 * focus state machine - that tracks whether the *device* is alive, and this
 * line is the server talking about a request the device made. The frame that
 * follows does the flushing, as it always did.
 */
export function recordSttRequest(stt: RecordedSttRequest): void {
  if (!glassesRecordingEnabled()) return;
  if (!announced) {
    announced = true;
    console.log(`[glasses-recorder] recording to ${recordingDir()} (${RECORD_ENV} is set)`);
  }
  const line: RecordedGlassesLine = { stt, at: Date.now(), server: VERSION };
  enqueue(() => appendLine(line, dayStamp(line.at)));
}

/** Key of the last focus WRITTEN to disk (not merely observed). */
let lastFocusKey: string | null = null;
/** Focus observed while the glasses were off, parked until they speak again.
 *  Only the latest matters: it is context for the next frame, not history. */
let pendingFocus: ClientFocus | null | undefined;

function focusLine(
  focus: ClientFocus | undefined,
): Extract<RecordedGlassesLine, { focus: string | null }> {
  return focus
    ? { focus: focus.sessionId, deviceType: focus.deviceType, at: focus.at, receivedAt: Date.now(), server: VERSION }
    : { focus: null, at: Date.now(), receivedAt: Date.now(), server: VERSION };
}

function focusKeyOf(focus: ClientFocus | undefined): string {
  return focus ? `${focus.sessionId}:${focus.deviceType}` : '';
}

/** Write the parked focus, if it still differs from the last one on disk.
 *  Called on the live transition, before the frame/gesture that caused it. */
function flushPendingFocus(): void {
  if (pendingFocus === undefined) return;
  const focus = pendingFocus ?? undefined;
  pendingFocus = undefined;
  const key = focusKeyOf(focus);
  if (key === lastFocusKey) return;
  lastFocusKey = key;
  const line = focusLine(focus);
  enqueue(() => appendLine(line, dayStamp(line.receivedAt)));
}

/**
 * Record which session the user is working in, whenever the focus election's
 * answer changes. This is the phone/tablet's focus, not the glasses' cursor —
 * the latter rides on the frames themselves (`GlassesScreen.session`). Both
 * are written so analysis can group a recording by what was being worked on.
 *
 * This is a glasses recording, and focus moves with no glasses anywhere —
 * a phone browsed all day used to bookend every file with hours of focus
 * lines nothing could replay. So focus is written only while the glasses are
 * live (frames or gestures since the last gap); off-air changes are parked
 * and the latest one is flushed as context when the glasses speak again.
 */
export function recordGlassesFocus(focus: ClientFocus | undefined): void {
  if (!glassesRecordingEnabled()) return;
  if (!recordedSinceGap) {
    // Parked even when unchanged-looking: `undefined` means "nothing parked",
    // so a cleared focus is stored as null to keep the two states apart.
    pendingFocus = focus ?? null;
    return;
  }
  const key = focusKeyOf(focus);
  if (key === lastFocusKey) return;
  lastFocusKey = key;
  const line = focusLine(focus);
  enqueue(() => appendLine(line, dayStamp(line.receivedAt)));
}

// ── Reading, for the replay player ──

export interface RecordingDaySummary {
  /** YYYY-MM-DD, server-local. */
  day: string;
  bytes: number;
}

/** Valid day-file name, and the shape the :day route param must match. */
export const RECORDING_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Days with recorded frames, oldest first. Reads regardless of the record
 *  flag: old footage stays replayable after recording is switched off. */
export async function listRecordingDays(): Promise<RecordingDaySummary[]> {
  let entries: string[];
  try {
    entries = await readdir(recordingDir());
  } catch {
    return [];
  }
  const days: RecordingDaySummary[] = [];
  for (const name of entries.sort()) {
    const match = DAY_FILE_RE.exec(name);
    if (!match) continue;
    try {
      const info = await stat(join(recordingDir(), name));
      days.push({ day: name.slice(0, -'.jsonl'.length), bytes: info.size });
    } catch {
      /* deleted between readdir and stat */
    }
  }
  return days;
}

/** All lines of one day, in recorded order. `null` when the day has no file.
 *  A torn last line (crash mid-append) is dropped, not fatal. */
export async function readRecordingDay(day: string): Promise<RecordedGlassesLine[] | null> {
  if (!RECORDING_DAY_RE.test(day)) return null;
  let raw: string;
  try {
    raw = await readFile(join(recordingDir(), `${day}.jsonl`), 'utf-8');
  } catch {
    return null;
  }
  const lines: RecordedGlassesLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as RecordedGlassesLine);
    } catch {
      /* torn line */
    }
  }
  return lines;
}

/** Wait for queued disk work to settle (tests, shutdown). */
export function flushGlassesRecorder(): Promise<void> {
  return queue.then(
    () => undefined,
    () => undefined,
  );
}

/** Reset module state so tests see a fresh recorder. */
export function resetGlassesRecorderForTest(): void {
  queue = Promise.resolve();
  announced = false;
  lastFrameKey = null;
  recordedSinceGap = false;
  lastFocusKey = null;
  pendingFocus = undefined;
  lastPrunedDay = null;
}
