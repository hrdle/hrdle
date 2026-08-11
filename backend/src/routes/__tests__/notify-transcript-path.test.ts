import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAllowedTranscriptPath } from '../notify';

const claudeDir = join(homedir(), '.claude');
const realFile = join(claudeDir, '.hrdle-test-transcript.jsonl');
const linkFile = join(claudeDir, '.hrdle-test-escape-link.jsonl');
const kimiDir = join(homedir(), '.kimi-code');
const kimiFile = join(kimiDir, '.hrdle-test-transcript.jsonl');

describe('isAllowedTranscriptPath', () => {
  beforeAll(async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(realFile, '{}\n');
    await rm(linkFile, { force: true });
    await symlink('/etc/hosts', linkFile);
    await mkdir(kimiDir, { recursive: true });
    await writeFile(kimiFile, '{}\n');
  });

  afterAll(async () => {
    await rm(realFile, { force: true });
    await rm(linkFile, { force: true });
    await rm(kimiFile, { force: true });
  });

  test('allows a transcript under ~/.claude', async () => {
    expect(await isAllowedTranscriptPath(realFile)).toBe(true);
  });

  test('allows a transcript under ~/.kimi-code', async () => {
    expect(await isAllowedTranscriptPath(kimiFile)).toBe(true);
  });

  test('rejects files outside the allowed dirs', async () => {
    expect(await isAllowedTranscriptPath('/etc/passwd')).toBe(false);
  });

  test('rejects nonexistent paths', async () => {
    expect(await isAllowedTranscriptPath(join(claudeDir, 'no-such-file.jsonl'))).toBe(false);
  });

  test('rejects traversal that resolves outside the allowed dirs', async () => {
    expect(await isAllowedTranscriptPath(join(claudeDir, '..', '..', 'etc', 'passwd'))).toBe(false);
  });

  test('rejects symlinks escaping the allowed dirs', async () => {
    expect(await isAllowedTranscriptPath(linkFile)).toBe(false);
  });
});
