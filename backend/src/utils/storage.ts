import { join } from 'node:path';
import { mkdir, writeFile, rename, stat, unlink, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { IDENTITY } from '../../../shared/identity';

export function getDataDir(): string {
  return (
    process.env[IDENTITY.dataDirEnv] || join(homedir(), IDENTITY.dataDirName)
  );
}

/** `~/.config/hrdle` — service env file and other non-data config. */
export function getConfigDir(): string {
  return join(homedir(), '.config', IDENTITY.configDirName);
}

export async function ensureDataDir(): Promise<string> {
  const dataDir = getDataDir();
  await mkdir(dataDir, { recursive: true });
  return dataDir;
}

/**
 * Carry a data file across a rename of the thing that owns it.
 *
 * Renaming a service means renaming its store, and a store in this directory
 * is usually the only copy of something — a usage tally nothing can re-derive,
 * a set of remembered sessions. Left to itself the service simply starts empty
 * under the new name, which reads as data loss and is one.
 *
 * The generic part is kept here on purpose; **each use of it is still a
 * migration and still expires.** Call it with the delete-by date at the call
 * site, and when that date comes the deletion is one line plus one constant,
 * which is what the week rule in CLAUDE.md asks of a migration.
 *
 * Three properties worth relying on:
 *
 * - **The new name wins.** If it already exists nothing happens, so this can
 *   never land on top of live data — including on the second start after the
 *   rename, and including when someone restores an old file by hand.
 * - **Failure is silent and safe.** A missing legacy file is the ordinary case
 *   (a fresh install), and a rename that cannot be performed leaves the caller
 *   exactly where it would have been without this: reading nothing.
 * - **It is a rename, not a copy.** One reader, one file, no question later
 *   about which of the two is authoritative.
 *
 * Returns whether the file was actually moved, which is what a test asserts on.
 */
export async function migrateDataFileName(
  dir: string,
  legacyName: string,
  currentName: string,
): Promise<boolean> {
  try {
    await stat(join(dir, currentName));
    return false;
  } catch {
    // Not on the current name yet, which is the only case worth acting on.
  }
  try {
    await rename(join(dir, legacyName), join(dir, currentName));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write to a sibling temp file and rename atomically so a crash mid-write
 * can't truncate the target (a truncated JSON store reads back as empty and
 * silently loses everything it held). Same pattern as peer-registry.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  mode?: number,
): Promise<void> {
  const tempPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tempPath, content, mode !== undefined ? { mode } : undefined);
    // writeFile's mode is subject to umask and only applies on create, so a
    // file holding a secret gets an explicit chmod — and it happens before the
    // rename, so the target is never briefly readable by anyone else.
    if (mode !== undefined) await chmod(tempPath, mode);
    await rename(tempPath, filePath);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      /* best-effort cleanup if rename never happened */
    }
    throw err;
  }
}

/**
 * Create a mutex that serialises load→mutate→save sequences against a single
 * store file. Without it, overlapping read-modify-write calls clobber each
 * other's changes (lost update). One lock per store file.
 */
export function createMutationLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    // Don't propagate failures into the queue's success chain — the next
    // caller must still get to run even if this one rejected.
    queue = next.catch(() => undefined);
    return next;
  };
}
