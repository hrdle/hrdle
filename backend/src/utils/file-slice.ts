import { closeSync, openSync, readSync, statSync } from 'node:fs';

function readSlice(path: string, maxBytes: number, fromEnd: boolean): string | undefined {
  try {
    const { size } = statSync(path);
    const length = Math.min(size, maxBytes);
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
      return buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * At most the first `maxBytes` of a file, or undefined when it cannot be read.
 * The last line may be cut off, so a caller parsing lines must tolerate one
 * that does not parse.
 */
export function readFileHeadSync(path: string, maxBytes: number): string | undefined {
  return readSlice(path, maxBytes, false);
}

/**
 * At most the last `maxBytes` of a file, or undefined when it cannot be read.
 * Agents' transcripts grow to many megabytes and are re-read on every sessions
 * push, so only the end, where the latest usage and answer are, is read. The
 * first line may be cut off.
 */
export function readFileTailSync(path: string, maxBytes: number): string | undefined {
  return readSlice(path, maxBytes, true);
}
