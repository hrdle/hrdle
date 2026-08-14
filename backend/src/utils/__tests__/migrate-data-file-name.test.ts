// Renaming a service means renaming its store, and a store in the data
// directory is usually the only copy of something. The property that matters
// most here is the refusal: whatever else happens, a file already sitting under
// the current name is never written over.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDataFileName } from '../storage';

const LEGACY = 'old-name.json';
const CURRENT = 'new-name.json';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'migrate-data-file-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = (name: string) => readFile(join(dir, name), 'utf-8');

describe('migrateDataFileName', () => {
  test('moves the legacy file onto the current name, contents intact', async () => {
    await writeFile(join(dir, LEGACY), '{"days":{"2026-08-12":{"requests":330}}}');

    expect(await migrateDataFileName(dir, LEGACY, CURRENT)).toBe(true);

    expect(JSON.parse(await read(CURRENT)).days['2026-08-12'].requests).toBe(330);
    // A rename, not a copy: one reader, one file, nothing left to wonder about.
    expect(read(LEGACY)).rejects.toThrow();
  });

  /**
   * The one that must never fail. The second start after a rename has both a
   * live file under the current name and, until the migration is deleted, a
   * caller still asking - and so does anyone who restores an old file by hand.
   */
  test('refuses when the current name already exists', async () => {
    await writeFile(join(dir, CURRENT), '{"live":true}');
    await writeFile(join(dir, LEGACY), '{"stale":true}');

    expect(await migrateDataFileName(dir, LEGACY, CURRENT)).toBe(false);

    expect(JSON.parse(await read(CURRENT)).live).toBe(true);
    // The stale file is left where it is rather than deleted: this function's
    // job is to not lose data, and removing a file it decided not to use would
    // be the opposite.
    expect(JSON.parse(await read(LEGACY)).stale).toBe(true);
  });

  /** A fresh install, which is the common case once the migration is old. */
  test('does nothing when neither file exists', async () => {
    expect(await migrateDataFileName(dir, LEGACY, CURRENT)).toBe(false);
    expect(read(CURRENT)).rejects.toThrow();
  });

  /** The caller reads next and finds nothing, exactly as it would have without
   *  this - a migration that cannot run must not be a migration that throws. */
  test('reports false rather than throwing when the directory is absent', async () => {
    expect(await migrateDataFileName(join(dir, 'nope'), LEGACY, CURRENT)).toBe(false);
  });

  test('is safe to run twice', async () => {
    await writeFile(join(dir, LEGACY), '{"n":1}');

    expect(await migrateDataFileName(dir, LEGACY, CURRENT)).toBe(true);
    expect(await migrateDataFileName(dir, LEGACY, CURRENT)).toBe(false);

    expect(JSON.parse(await read(CURRENT)).n).toBe(1);
  });
});
