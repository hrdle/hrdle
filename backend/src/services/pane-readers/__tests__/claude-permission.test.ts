import { describe, expect, test } from 'bun:test';
import { readClaudePermission } from '../claude-permission';

const fixture = async (name: string) =>
  (await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text()).split('\n');

describe('readClaudePermission', () => {
  test('reads a Bash prompt, rejoining a wrapped row and splitting off its note', async () => {
    const p = readClaudePermission(await fixture('claude-permission-bash.txt'));
    expect(p).toBeDefined();
    expect(p?.title).toBe('Bash command');
    expect(p?.question).toBe('Do you want to proceed?');
    expect(p?.detail).toEqual(['Create empty file made-by-claude.txt', 'touch made-by-claude.txt']);
    expect(p?.options).toEqual([
      { label: 'Yes' },
      { label: 'Yes, and always allow access to /home/dev/work/projects/permission-fixture/proj from this project' },
      { label: 'Yes, and switch to auto mode', description: 'auto mode handles these prompts for you' },
      { label: 'No' },
    ]);
    expect(p?.cursor).toBe(0);
    expect(p?.amend).toBe(true);
  });

  test('on a phone-width pane, rejoins wrapped lines by the pane width', async () => {
    const p = readClaudePermission(await fixture('claude-permission-narrow.txt'));
    expect(p?.detail).toEqual(['Write "first" to one.txt', 'echo first > one.txt']);
    expect(p?.options).toEqual([
      { label: 'Yes' },
      { label: 'Yes, and always allow access to /home/dev/work/projects/permission-fixture/a-path-long-enough-to-be-cut-mid-word-by-th/perm/proj from this project' },
      { label: 'Yes, and switch to auto mode', description: 'auto mode handles these prompts for you' },
      { label: 'No' },
    ]);
  });

  test('reads an Edit prompt with its diff as the detail', async () => {
    const p = readClaudePermission(await fixture('claude-permission-edit.txt'));
    expect(p?.title).toBe('Edit file');
    expect(p?.question).toBe('Do you want to make this edit to note.txt?');
    expect(p?.detail).toEqual(['note.txt', '1 -hello', '1 +goodbye']);
    expect(p?.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
      'No',
    ]);
  });

  test('follows the cursor and reports no amend once a row is being amended', async () => {
    const p = readClaudePermission(await fixture('claude-permission-amending.txt'));
    expect(p?.cursor).toBe(3);
    expect(p?.amend).toBe(false);
  });

  test('leaves the question picker alone, even when its footer wraps', () => {
    const picker = [
      '─'.repeat(48),
      '←  ☐ 休日  ✔ Submit  →',
      '',
      'どれにしますか？',
      '',
      '❯ 1. 読書',
      '  2. ゲーム',
      '─'.repeat(48),
      '  3. Chat about this',
      '',
      'Enter to select · Tab/Arrow keys to navigate ·',
      'Esc to cancel',
    ];
    expect(readClaudePermission(picker)).toBeUndefined();
  });

  test('leaves the folder trust prompt alone', () => {
    const trust = [
      '─'.repeat(48),
      ' Accessing workspace:',
      ' Is this a project you created or one you trust?',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
    ];
    expect(readClaudePermission(trust)).toBeUndefined();
  });

  test('takes nothing from numbered output above an idle input box', () => {
    const idle = ['Which one?', '1. a', '2. b', '─'.repeat(48), '❯ ', '─'.repeat(48), '  ⏸ manual mode on'];
    expect(readClaudePermission(idle)).toBeUndefined();
  });
});
