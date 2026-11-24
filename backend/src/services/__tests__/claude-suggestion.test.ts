import { describe, expect, test } from 'bun:test';
import { parseClaudeSuggestion } from '../claude-suggestion';

const fixture = async () =>
  Bun.file(new URL('./fixtures/claude-suggestion.ansi', import.meta.url)).text();

const RULE = `\x1b[0m\x1b[38;2;136;136;136m${'─'.repeat(60)}\x1b[0m`;
const FOOTER = '  \x1b[0m\x1b[38;2;255;193;7m⏵⏵ auto mode on\x1b[0m';
const box = (...inside: string[]) => ['● done', '', RULE, ...inside, RULE, FOOTER].join('\n');

describe('parseClaudeSuggestion', () => {
  test('reads the faint prompt in the input box', async () => {
    expect(parseClaudeSuggestion(await fixture())).toBe('note.txt の中身を見せて');
  });

  test('reads nothing from words the person typed', () => {
    expect(parseClaudeSuggestion(box('❯ abc\r'))).toBeNull();
  });

  test('reads nothing when typed words follow a faint remainder', () => {
    expect(parseClaudeSuggestion(box('❯ ab\x1b[2mc\x1b[0m'))).toBeNull();
  });

  test('reads nothing from an empty box', () => {
    expect(parseClaudeSuggestion(box('❯ '))).toBeNull();
  });

  test('rejoins a suggestion wrapped over two lines', () => {
    expect(
      parseClaudeSuggestion(box('❯ \x1b[2mrun the\x1b[0m', '  \x1b[2mtests again\x1b[0m')),
    ).toBe('run the tests again');
    expect(parseClaudeSuggestion(box('❯ \x1b[2mテストを\x1b[0m', '  \x1b[2mもう一度\x1b[0m'))).toBe(
      'テストをもう一度',
    );
  });

  test('does not take a 256-colour parameter of 2 for faint', () => {
    expect(parseClaudeSuggestion(box('❯ \x1b[38;5;2mgreen words\x1b[0m'))).toBeNull();
  });

  test('reads nothing when the screen is not showing the input box', () => {
    expect(parseClaudeSuggestion(['❯ \x1b[2mfaint\x1b[0m', 'some output'].join('\n'))).toBeNull();
  });
});
