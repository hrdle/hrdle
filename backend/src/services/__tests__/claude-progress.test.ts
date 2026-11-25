import { describe, expect, test } from 'bun:test';
import { parseClaudeProgress } from '../claude-progress';

const fixture = async () =>
  Bun.file(new URL('./fixtures/claude-progress.txt', import.meta.url)).text();

const RULE = '─'.repeat(60);
const FOOTER = '  ⏵⏵ auto mode on · esc to interrupt';
const screen = (...above: string[]) => ['● earlier answer', '', ...above, '', RULE, '❯ ', RULE, FOOTER].join('\n');

describe('parseClaudeProgress', () => {
  test('reads the line from a real screen, past the tip under it', async () => {
    expect(parseClaudeProgress(await fixture())).toEqual({
      glyph: '·',
      label: 'Propagating…',
      detail: '42s · thought for 6s',
    });
  });

  test('reads the elapsed time and token count', () => {
    expect(parseClaudeProgress(screen('✻ Waddling… (5s · ↓ 390 tokens)'))).toEqual({
      glyph: '✻',
      label: 'Waddling…',
      detail: '5s · ↓ 390 tokens',
    });
  });

  test('reads a todo wording past the list under it', () => {
    expect(
      parseClaudeProgress(
        screen('✳ Writing the parser… (2m 3s · ↑ 3.1k tokens)', '  ⎿  ☒ Read the screen', '     ☐ Write the parser'),
      ),
    ).toEqual({ glyph: '✳', label: 'Writing the parser…', detail: '2m 3s · ↑ 3.1k tokens' });
  });

  test('drops key hints from the parentheses', () => {
    expect(parseClaudeProgress(screen('✶ Thinking… (esc to interrupt · 12s)'))?.detail).toBe('12s');
  });

  test('reads a line with no parentheses yet', () => {
    expect(parseClaudeProgress(screen('✢ Booping…'))).toEqual({ glyph: '✢', label: 'Booping…' });
  });

  test('reads nothing from a finished turn', () => {
    expect(parseClaudeProgress(screen('✻ Sautéed for 32s · done 8:32 AM'))).toBeNull();
  });

  test('reads nothing when the answer is the last thing above the box', () => {
    expect(parseClaudeProgress(screen('● Done… for now'))).toBeNull();
  });

  test('reads nothing without the input box', () => {
    expect(parseClaudeProgress('✻ Waddling… (5s)\n')).toBeNull();
  });
});
