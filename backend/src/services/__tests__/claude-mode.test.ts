import { describe, expect, test } from 'bun:test';
import { cycleToMode, parseClaudeMode, type ClaudeMode } from '../claude-mode';

const RULE = '─'.repeat(40);
const screen = (footer: string, prompt = '') =>
  ['● done', RULE, `❯ ${prompt}`, RULE, `  ~/repo`, `  ${footer}`].join('\n');

describe('parseClaudeMode', () => {
  test('reads each footer Claude Code shows', () => {
    expect(parseClaudeMode(screen('⏸ manual mode on'))).toBe('manual');
    expect(parseClaudeMode(screen('⏵⏵ accept edits on (shift+tab to cycle)'))).toBe('acceptEdits');
    expect(parseClaudeMode(screen('⏸ plan mode on (shift+tab to cycle)'))).toBe('plan');
    expect(parseClaudeMode(screen('⏵⏵ auto mode on · 1 shell · ↓ to manage'))).toBe('auto');
    expect(parseClaudeMode(screen('⏵⏵ bypass permissions on (shift+tab to cycle)'))).toBe('bypass');
  });

  test('takes nothing from the prompt being typed', () => {
    expect(parseClaudeMode(screen('? for shortcuts', 'turn plan mode on please'))).toBe('manual');
  });

  test('is null when the input box is not on screen', () => {
    expect(parseClaudeMode('a dialog\nwith no rule')).toBeNull();
  });
});

describe('cycleToMode', () => {
  const footers: Record<ClaudeMode, string> = {
    manual: '⏸ manual mode on',
    acceptEdits: '⏵⏵ accept edits on',
    plan: '⏸ plan mode on',
    auto: '⏵⏵ auto mode on',
    bypass: '⏵⏵ bypass permissions on',
  };
  const fake = (cycle: ClaudeMode[], start: number) => {
    let at = start;
    let presses = 0;
    return {
      io: {
        read: async () => screen(footers[cycle[at]!]),
        pressShiftTab: async () => {
          presses++;
          at = (at + 1) % cycle.length;
        },
        sleep: async () => {},
      },
      presses: () => presses,
    };
  };

  test('presses until the footer shows the target', async () => {
    const f = fake(['manual', 'acceptEdits', 'plan', 'auto'], 3);
    expect(await cycleToMode('plan', f.io)).toEqual({ ok: true, mode: 'plan' });
    expect(f.presses()).toBe(3);
  });

  test('presses nothing when already there', async () => {
    const f = fake(['manual', 'acceptEdits', 'plan', 'auto'], 2);
    expect(await cycleToMode('plan', f.io)).toEqual({ ok: true, mode: 'plan' });
    expect(f.presses()).toBe(0);
  });

  test('gives up on a mode the session does not offer', async () => {
    const f = fake(['manual', 'acceptEdits', 'plan'], 0);
    const result = await cycleToMode('auto', f.io);
    expect(result.ok).toBe(false);
  });
});
