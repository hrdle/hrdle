import { join } from 'node:path';
import { mkdir, writeFile, rename, unlink, chmod } from 'node:fs/promises';
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
