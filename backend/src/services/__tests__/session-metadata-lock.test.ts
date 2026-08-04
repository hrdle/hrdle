import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../../shared/identity';

// Force the data directory before the module loads so session-metadata.json
// lands in our scratch dir. ensureDataDir reads this variable. #333
//
// Taken from identity rather than written out: renaming the variable (#459)
// does not fail a test that spells it — it stops redirecting it, and the test
// then writes its fixtures into the real data directory and still passes.
const DATA_DIR_ENV = IDENTITY.dataDirEnv;

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), `${IDENTITY.tmpPrefix}-meta-`));
  originalDataDir = process.env[DATA_DIR_ENV];
  process.env[DATA_DIR_ENV] = tempDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = originalDataDir;
  await rm(tempDir, { recursive: true, force: true });
});

describe('session-metadata mutation lock', () => {
  test('concurrent theme updates do not overwrite each other', async () => {
    const meta = await import('../session-metadata');

    // Interleave updates that all do load→mutate→save on the same file.
    // Without the mutation lock, overlapping sequences drop each other's
    // writes (lost update).
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      ops.push(meta.setSessionTheme('ses-a', 'blue'));
      ops.push(meta.setSessionTheme('ses-b', 'red'));
      ops.push(meta.setSessionTheme(`ses-${i}`, 'green'));
    }
    await Promise.all(ops);

    const sessions = await meta.getAllSessionMetadata();
    expect(sessions['ses-a']?.theme).toBe('blue');
    expect(sessions['ses-b']?.theme).toBe('red');
    expect(sessions['ses-19']?.theme).toBe('green');

    // The file on disk must always be complete JSON (atomic temp+rename).
    const text = await readFile(join(tempDir, 'herdr-session-metadata.json'), 'utf-8');
    const parsed = JSON.parse(text);
    expect(parsed.sessions['ses-a'].theme).toBe('blue');
  });

  test('renameSessionMetadata moves the theme to the new id', async () => {
    const meta = await import('../session-metadata');

    await meta.setSessionTheme('old-name', 'purple');
    await meta.renameSessionMetadata('old-name', 'new-name');

    const sessions = await meta.getAllSessionMetadata();
    expect(sessions['old-name']).toBeUndefined();
    expect(sessions['new-name']?.theme).toBe('purple');
  });

  test('concurrent last-known-session updates are serialised', async () => {
    const meta = await import('../session-metadata');

    await meta.saveLastKnownSessions([
      { id: 's1', name: 'one' },
      { id: 's2', name: 'two' },
      { id: 's3', name: 'three' },
    ]);
    await Promise.all([
      meta.removeLastKnownSession('s1'),
      meta.removeLastKnownSession('s3'),
    ]);

    const remaining = await meta.getLastKnownSessions();
    expect(remaining.map(s => s.id)).toEqual(['s2']);
  });
});
