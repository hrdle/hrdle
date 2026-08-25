import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeService } from '../claude-code';

// A transcript read on every session push must give its descriptor back. The
// count is taken from the process itself, because a stream that is merely
// closed by readline still holds the file open.
const canCount = existsSync('/proc/self/fd');
const openDescriptors = () => readdirSync('/proc/self/fd').length;

function transcript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'hrdle-transcript-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe.skipIf(!canCount)('reading the recorded cwd releases the file', () => {
  const svc = new ClaudeCodeService();
  const read = (file: string) =>
    (svc as unknown as { readRecordedCwd(p: string): Promise<string | null> }).readRecordedCwd(file);

  test('when the cwd is on the first line', async () => {
    const file = transcript([JSON.stringify({ cwd: '/work/here' }), ...Array(50).fill('{}')]);
    expect(await read(file)).toBe('/work/here');
    const before = openDescriptors();
    for (let i = 0; i < 20; i++) await read(file);
    expect(openDescriptors()).toBe(before);
  });

  test('when the head runs out before any cwd', async () => {
    const file = transcript(Array(300).fill(JSON.stringify({ type: 'progress' })));
    expect(await read(file)).toBeNull();
    const before = openDescriptors();
    for (let i = 0; i < 20; i++) await read(file);
    expect(openDescriptors()).toBe(before);
  });
});
