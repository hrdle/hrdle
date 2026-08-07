import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY, envVar } from '../../../../shared/identity';
import type { GlassesScreen } from '../../../../shared/types';
import {
  flushGlassesRecorder,
  glassesRecordingEnabled,
  listRecordingDays,
  readRecordingDay,
  recordGlassesFocus,
  recordGlassesInput,
  recordGlassesScreen,
  resetGlassesRecorderForTest,
} from '../glasses-screen-recorder';

const RECORD_ENV = envVar('GLASSES_RECORD');
const DATA_DIR_ENV = IDENTITY.dataDirEnv;

let dataDir: string;
let savedRecord: string | undefined;
let savedDataDir: string | undefined;

function frame(overrides: Partial<GlassesScreen> = {}): GlassesScreen {
  return {
    header: 'dev *',
    body: 'building...',
    footer: 'tap: menu',
    mode: 'conversation',
    at: Date.now(),
    ...overrides,
  };
}

function recordingDir(): string {
  return join(dataDir, 'glasses-screen-recording');
}

async function readLines(): Promise<Array<Record<string, unknown>>> {
  const files = (await readdir(recordingDir())).filter((f) => f.endsWith('.jsonl')).sort();
  const lines: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const raw = await readFile(join(recordingDir(), file), 'utf-8');
    for (const line of raw.split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line));
    }
  }
  return lines;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'glasses-recorder-test-'));
  savedRecord = process.env[RECORD_ENV];
  savedDataDir = process.env[DATA_DIR_ENV];
  process.env[DATA_DIR_ENV] = dataDir;
  process.env[RECORD_ENV] = '1';
  resetGlassesRecorderForTest();
});

afterEach(async () => {
  if (savedRecord === undefined) delete process.env[RECORD_ENV];
  else process.env[RECORD_ENV] = savedRecord;
  if (savedDataDir === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = savedDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe('glassesRecordingEnabled', () => {
  it('is off by default and on for 1/true', () => {
    delete process.env[RECORD_ENV];
    expect(glassesRecordingEnabled()).toBe(false);
    process.env[RECORD_ENV] = '0';
    expect(glassesRecordingEnabled()).toBe(false);
    process.env[RECORD_ENV] = '1';
    expect(glassesRecordingEnabled()).toBe(true);
    process.env[RECORD_ENV] = 'true';
    expect(glassesRecordingEnabled()).toBe(true);
  });
});

describe('recordGlassesScreen', () => {
  it('writes nothing when disabled', async () => {
    delete process.env[RECORD_ENV];
    recordGlassesScreen(frame());
    await flushGlassesRecorder();
    expect(existsSync(recordingDir())).toBe(false);
  });

  it('appends frames to a per-day JSONL file', async () => {
    const at = Date.now();
    recordGlassesScreen(frame({ body: 'one', at }));
    recordGlassesScreen(frame({ body: 'two', at: at + 1 }));
    await flushGlassesRecorder();

    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`;
    expect(await readdir(recordingDir())).toEqual([expected]);

    const lines = await readLines();
    expect(lines.map((l) => l.body)).toEqual(['one', 'two']);
    expect(lines[0]?.at).toBe(at);
    // Server arrival clock recorded alongside the device's own stamp.
    expect(typeof lines[0]?.receivedAt).toBe('number');
  });

  it('skips identical consecutive frames but keeps changed ones', async () => {
    const base = Date.now();
    recordGlassesScreen(frame({ body: 'same', at: base }));
    recordGlassesScreen(frame({ body: 'same', at: base + 1 }));
    recordGlassesScreen(frame({ body: 'changed', at: base + 2 }));
    recordGlassesScreen(frame({ body: 'same', at: base + 3 }));
    await flushGlassesRecorder();

    const lines = await readLines();
    expect(lines.map((l) => l.body)).toEqual(['same', 'changed', 'same']);
  });

  it('writes one gap marker on publisher disconnect, never two in a row', async () => {
    recordGlassesScreen(frame({ body: 'live' }));
    recordGlassesScreen(null);
    recordGlassesScreen(null);
    await flushGlassesRecorder();

    const lines = await readLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]?.gap).toBe(true);
    expect(typeof lines[1]?.at).toBe('number');
  });

  it('writes no gap marker before any frame was recorded', async () => {
    recordGlassesScreen(null);
    await flushGlassesRecorder();
    expect(existsSync(recordingDir())).toBe(false);
  });

  it('records a frame identical to the pre-gap one (the screen came back)', async () => {
    const base = Date.now();
    recordGlassesScreen(frame({ body: 'same', at: base }));
    recordGlassesScreen(null);
    recordGlassesScreen(frame({ body: 'same', at: base + 1 }));
    await flushGlassesRecorder();

    const lines = await readLines();
    expect(lines.map((l) => l.gap ?? l.body)).toEqual(['same', true, 'same']);
  });

  it('records ring gestures between frames, with the server clock', async () => {
    recordGlassesScreen(frame({ body: 'before' }));
    recordGlassesInput({ kind: 'tap', at: 123 });
    recordGlassesScreen(frame({ body: 'after' }));
    await flushGlassesRecorder();

    const lines = await readLines();
    expect(lines.map((l) => l.input ?? l.body)).toEqual(['before', 'tap', 'after']);
    expect(lines[1]?.at).toBe(123);
    expect(typeof lines[1]?.receivedAt).toBe('number');
  });

  it('a gesture after a gap lets the next disconnect write a fresh gap', async () => {
    recordGlassesScreen(frame({ body: 'x' }));
    recordGlassesScreen(null);
    recordGlassesInput({ kind: 'swipeUp', at: Date.now() });
    recordGlassesScreen(null);
    await flushGlassesRecorder();

    const lines = await readLines();
    expect(lines.map((l) => l.input ?? l.gap ?? l.body)).toEqual(['x', true, 'swipeUp', true]);
  });

  it('records focus changes once per change while the glasses are live', async () => {
    recordGlassesScreen(frame({ body: 'on' }));
    recordGlassesFocus({ sessionId: 'dev', deviceType: 'mobile', at: 111 });
    recordGlassesFocus({ sessionId: 'dev', deviceType: 'mobile', at: 222 }); // unchanged
    recordGlassesFocus({ sessionId: 'docs', deviceType: 'tablet', at: 333 });
    recordGlassesFocus(undefined);
    recordGlassesFocus(undefined); // still cleared
    await flushGlassesRecorder();

    const lines = await readLines();
    expect(lines.map((l) => ('focus' in l ? l.focus : l.body))).toEqual(['on', 'dev', 'docs', null]);
    expect(lines[1]).toMatchObject({ focus: 'dev', deviceType: 'mobile', at: 111 });
    expect(typeof lines[3]?.receivedAt).toBe('number');
  });

  it('parks focus while the glasses are off and flushes the latest before the next frame', async () => {
    // This is a glasses recording: a phone browsed all day must not fill the
    // file with focus lines nothing can replay.
    recordGlassesFocus({ sessionId: 'dev', deviceType: 'mobile', at: 1 });
    recordGlassesFocus({ sessionId: 'docs', deviceType: 'mobile', at: 2 });
    await flushGlassesRecorder();
    expect(existsSync(recordingDir())).toBe(false); // nothing written at all

    recordGlassesScreen(frame({ body: 'first' }));
    await flushGlassesRecorder();

    const lines = await readLines();
    // Only the latest parked focus, and it precedes the frame it labels.
    expect(lines.map((l) => l.focus ?? l.body)).toEqual(['docs', 'first']);
  });

  it('focus changed and changed back while off writes nothing on resume', async () => {
    recordGlassesScreen(frame({ body: 'a' }));
    recordGlassesFocus({ sessionId: 'dev', deviceType: 'mobile', at: 1 });
    recordGlassesScreen(null); // glasses off
    recordGlassesFocus({ sessionId: 'docs', deviceType: 'mobile', at: 2 });
    recordGlassesFocus({ sessionId: 'dev', deviceType: 'mobile', at: 3 }); // back
    recordGlassesScreen(frame({ body: 'b' }));
    await flushGlassesRecorder();

    const lines = await readLines();
    expect(lines.map((l) => l.focus ?? l.gap ?? l.body)).toEqual(['a', 'dev', true, 'b']);
  });

  it('a gesture flushes the parked focus too', async () => {
    recordGlassesFocus({ sessionId: 'dev', deviceType: 'mobile', at: 1 });
    recordGlassesInput({ kind: 'tap', at: Date.now() });
    await flushGlassesRecorder();

    const lines = await readLines();
    expect(lines.map((l) => l.focus ?? l.input)).toEqual(['dev', 'tap']);
  });

  it('a frame carrying session metadata records it, and a session change alone re-records', async () => {
    const base = Date.now();
    const session = { id: 'w1', name: 'dev' };
    recordGlassesScreen({ ...frame({ body: 'same', at: base }), session });
    recordGlassesScreen({ ...frame({ body: 'same', at: base + 1 }), session: { id: 'w2', name: 'docs' } });
    await flushGlassesRecorder();

    const lines = await readLines();
    expect(lines.map((l) => (l.session as { id: string }).id)).toEqual(['w1', 'w2']);
  });

  it('lists recorded days and reads one back', async () => {
    recordGlassesScreen(frame({ body: 'recorded' }));
    await flushGlassesRecorder();

    const days = await listRecordingDays();
    expect(days).toHaveLength(1);
    expect(days[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(days[0]?.bytes).toBeGreaterThan(0);

    const dayKey = days[0]?.day ?? '';
    const lines = await readRecordingDay(dayKey);
    expect(lines).toHaveLength(1);
    expect(lines?.[0]).toMatchObject({ body: 'recorded' });
  });

  it('lists nothing before any recording exists', async () => {
    expect(await listRecordingDays()).toEqual([]);
  });

  it('rejects day names that are not YYYY-MM-DD (path traversal guard)', async () => {
    expect(await readRecordingDay('../glasses-settings')).toBeNull();
    expect(await readRecordingDay('2026-08-02.jsonl')).toBeNull();
    expect(await readRecordingDay('2026-01-01')).toBeNull(); // valid shape, no file
  });

  it('drops a torn trailing line instead of failing the day', async () => {
    await mkdir(recordingDir(), { recursive: true });
    await writeFile(
      join(recordingDir(), '2026-01-05.jsonl'),
      '{"gap":true,"at":1}\n{"header":"x","body":"y","foo',
    );
    const lines = await readRecordingDay('2026-01-05');
    expect(lines).toEqual([{ gap: true, at: 1 }]);
  });

  it('prunes day files older than the retention window', async () => {
    await mkdir(recordingDir(), { recursive: true });
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const oldName = `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}.jsonl`;
    await writeFile(join(recordingDir(), oldName), '{"gap":true,"at":0}\n');
    await writeFile(join(recordingDir(), 'notes.txt'), 'kept: not a day file\n');

    recordGlassesScreen(frame());
    await flushGlassesRecorder();

    const files = await readdir(recordingDir());
    expect(files).not.toContain(oldName);
    expect(files).toContain('notes.txt');
    expect(files.some((f) => f.endsWith('.jsonl'))).toBe(true);
  });
});

describe('a recorded line says which build wrote it', () => {
  /**
   * A recording is read days later to decide whether something is fixed, and
   * on 2026-08-08 it could not answer that: three ehpk builds and three server
   * versions shipped in one morning, and telling which pair drew a frame meant
   * correlating the file against a console log that happened to print the
   * version.
   */
  it('carries the app build from the frame and stamps the server itself', async () => {
    recordGlassesScreen(frame({ app: '0.0.63', appCommit: '2f15190' }));
    await flushGlassesRecorder();
    const [line] = await readLines();
    expect(line.app).toBe('0.0.63');
    expect(line.appCommit).toBe('2f15190');
    expect(typeof line.server).toBe('string');
    expect((line.server as string).length).toBeGreaterThan(0);
  });

  it('stamps the server on a gap too, so a disconnect says who saw it', async () => {
    recordGlassesScreen(frame());
    recordGlassesScreen(null);
    await flushGlassesRecorder();
    const gap = (await readLines()).find((l) => l.gap === true);
    expect(typeof gap?.server).toBe('string');
  });
});
