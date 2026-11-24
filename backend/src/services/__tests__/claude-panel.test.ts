import { describe, expect, test } from 'bun:test';
import { parseClaudePanel } from '../claude-panel';

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
const EDGE = '▔'.repeat(60);
const RULE = '─'.repeat(60);

describe('parseClaudePanel', () => {
  test('reads the /model panel from its top edge to the bottom, without the shared indent', async () => {
    const panel = parseClaudePanel(await fixture('claude-panel-model.txt'));
    expect(panel?.lines[0]).toBe('Select model');
    expect(panel?.lines).toContain('❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks');
    expect(panel?.lines.at(-1)).toBe('s to use this session only · Enter to save · Esc to cancel');
  });

  test('reads nothing once the panel is closed', async () => {
    expect(parseClaudePanel(await fixture('claude-panel-closed.txt'))).toBeNull();
  });

  test('cuts off the input box drawn under a panel', () => {
    const screen = ['● done', EDGE, '  Settings  Status', '', '  ❯ Model  opus ›', '', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'].join('\n');
    expect(parseClaudePanel(screen)?.lines).toEqual(['Settings  Status', '', '❯ Model  opus ›']);
  });

  test('reads a panel taller than the screen, which has no footer', () => {
    const screen = ['x', EDGE, '  Current session', '  ████▌   17% used', '  Skills   % of usage', '                 ↓'].join('\n');
    expect(parseClaudePanel(screen)?.lines).toEqual([
      'Current session',
      '████▌   17% used',
      'Skills   % of usage',
      '               ↓',
    ]);
  });

  test('reads nothing from an empty edge', () => {
    expect(parseClaudePanel(['x', EDGE, '', ''].join('\n'))).toBeNull();
  });
});
