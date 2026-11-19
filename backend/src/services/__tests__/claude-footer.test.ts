import { describe, expect, it } from 'bun:test';
import { ClaudeBackgroundReader, parseClaudeBackground } from '../claude-footer';

const RULE = '─'.repeat(80);

function screen(...footer: string[]): string {
  return ['some earlier output', RULE, '❯ ', RULE, ...footer].join('\n');
}

describe('parseClaudeBackground', () => {
  it('reads the count from the mode line', () => {
    expect(
      parseClaudeBackground(screen('  m0a@:/home/m0a/repos/x', '  ⏵⏵ auto mode on · 1 shell')),
    ).toEqual(['1 shell']);
  });

  it('reads several kinds, in the order shown', () => {
    expect(
      parseClaudeBackground(screen('  ⏵⏵ auto mode on · 2 shells · 1 monitor')),
    ).toEqual(['2 shells', '1 monitor']);
  });

  it('is empty when nothing is running', () => {
    expect(
      parseClaudeBackground(screen('  m0a@:/x', '  ⏵⏵ auto mode on (shift+tab to cycle)')),
    ).toEqual([]);
  });

  it('ignores the same words in the prompt and the conversation', () => {
    const text = ['I started 2 shells · 1 monitor', RULE, '❯ kill the 3 shells', RULE, '  ⏵⏵ auto mode on'].join('\n');
    expect(parseClaudeBackground(text)).toEqual([]);
  });

  it('ignores a screen with no input box at the bottom', () => {
    const text = [RULE, 'line 1', 'line 2', '1 shell', 'line 4', 'line 5', 'line 6'].join('\n');
    expect(parseClaudeBackground(text)).toEqual([]);
    expect(parseClaudeBackground('$ ls\nfile · 1 shell')).toEqual([]);
  });

  it('survives the carriage returns herdr leaves on a row', () => {
    expect(parseClaudeBackground(screen('  ⏵⏵ auto mode on · 1 shell\r'))).toEqual(['1 shell']);
  });
});

describe('ClaudeBackgroundReader', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const footer = (text: string) => [RULE, '\u276f ', RULE, text].join('\n');

  it('answers at once with what it has and reads behind the call', async () => {
    let reads = 0;
    const reader = new ClaudeBackgroundReader(async () => {
      reads++;
      return footer('  auto mode on \u00b7 1 shell');
    });
    const now = Date.now();
    expect(reader.get('w1:p1', now)).toEqual([]);
    await tick();
    expect(reader.get('w1:p1', now)).toEqual(['1 shell']);
    expect(reads).toBe(1);
  });

  it('reads again only once the last answer has aged', async () => {
    let reads = 0;
    const reader = new ClaudeBackgroundReader(async () => {
      reads++;
      return footer('  auto mode on');
    });
    reader.get('w1:p1', Date.now());
    await tick();
    reader.get('w1:p1', Date.now());
    reader.get('w1:p1', Date.now() + 1000);
    await tick();
    expect(reads).toBe(1);
    reader.get('w1:p1', Date.now() + 60_000);
    await tick();
    expect(reads).toBe(2);
  });

  it('a failed read clears the badge rather than leaving a stale one', async () => {
    let fail = false;
    const reader = new ClaudeBackgroundReader(async () => {
      if (fail) throw new Error('gone');
      return footer('  auto mode on \u00b7 1 shell');
    });
    reader.get('w1:p1', Date.now());
    await tick();
    fail = true;
    reader.get('w1:p1', Date.now() + 60_000);
    await tick();
    expect(reader.get('w1:p1', Date.now() + 60_000)).toEqual([]);
  });
});
