import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileHeadSync, readFileTailSync } from '../file-slice';

let dir: string;
let path: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-slice-'));
  path = join(dir, 'log.jsonl');
  writeFileSync(path, 'first\nsecond\nthird\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readFileTailSync', () => {
  test('returns the whole file when it fits', () => {
    expect(readFileTailSync(path, 1024)).toBe('first\nsecond\nthird\n');
  });

  test('returns only the last bytes of a larger file', () => {
    expect(readFileTailSync(path, 7)).toBe('\nthird\n');
  });

  test('is undefined for a missing file', () => {
    expect(readFileTailSync(join(dir, 'missing'), 1024)).toBeUndefined();
  });
});

describe('readFileHeadSync', () => {
  test('returns the whole file when it fits', () => {
    expect(readFileHeadSync(path, 1024)).toBe('first\nsecond\nthird\n');
  });

  test('returns only the first bytes of a larger file', () => {
    expect(readFileHeadSync(path, 8)).toBe('first\nse');
  });

  test('is undefined for a missing file', () => {
    expect(readFileHeadSync(join(dir, 'missing'), 1024)).toBeUndefined();
  });
});
