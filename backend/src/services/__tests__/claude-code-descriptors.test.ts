import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeService } from '../claude-code';

// A transcript read on every session push must give its descriptor back. The
// count is taken from the process itself, because a stream that is merely
// closed by readline still holds the file open - and it is the count of
// descriptors on THIS file, since other tests in the same process open and
// close files of their own on their own schedule.
const canCount = existsSync('/proc/self/fd');
const openDescriptorsOf = (file: string) =>
  readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === file;
    } catch {
      return false;
    }
  }).length;

/**
 * The count once the close has landed, or the last count if it never does.
 *
 * `readRecordedCwd` calls `stream.destroy()` without awaiting it, so the
 * descriptor goes back on a later tick - and on a loaded machine that tick is
 * after the assertion. Read once, this passed on an idle laptop and failed in
 * CI at random. A leak still fails: nothing hands the descriptor back, so the
 * count never reaches zero and this returns it after the wait.
 */
async function settledDescriptorsOf(file: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  let count = openDescriptorsOf(file);
  while (count > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    count = openDescriptorsOf(file);
  }
  return count;
}

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
    for (let i = 0; i < 20; i++) await read(file);
    expect(await settledDescriptorsOf(file)).toBe(0);
  });

  test('when the head runs out before any cwd', async () => {
    const file = transcript(Array(300).fill(JSON.stringify({ type: 'progress' })));
    expect(await read(file)).toBeNull();
    for (let i = 0; i < 20; i++) await read(file);
    expect(await settledDescriptorsOf(file)).toBe(0);
  });
});
