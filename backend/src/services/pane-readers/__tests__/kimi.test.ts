// Reading Kimi Code's two prompts.
//
// Both fixtures are live 0.34.0 panes, captured on 2026-08-12 while testing the
// agents that had no reader of their own. One of them had never been readable
// at all.

import { describe, expect, test } from 'bun:test';
import { readKimiPrompt } from '../kimi';

/**
 * The trust prompt, shown once per folder. Nothing in it begins with a digit,
 * so every reader before this one found no options: the wearer was shown
 * `Trust this folder?` and no way to answer it.
 */
const TRUST = [
  '➜  kimi-trust kimi',
  ' ────────────────────────────────────────────',
  '  Trust this folder?',
  '  ↑↓ navigate · Enter select · Esc exit',
  '',
  '  /tmp/scratch/kimi-trust',
  '',
  '  Kimi Code loads project-level MCP servers',
  '  (.mcp.json, .kimi-code/mcp.json) only in',
  '  trusted folders. They run as local',
  '  processes on your machine.',
  '',
  '   ❯ Trust this folder',
  '     Enable project MCP servers. Remembered',
  '     for this folder.',
  '',
  '     Don\'t trust',
  '     Exit Kimi Code. Asked again next launch.',
  '',
  ' ────────────────────────────────────────────',
  '',
];

/** The approval prompt, asking to write a file. Numbered, and headed with the
 *  same glyph it marks the current row with. */
const APPROVAL = [
  '      1  added line',
  '      2',
  ' ────────────────────────────────────────────────',
  '   ▶ Write this file?',
  '',
  '   /tmp/scratch/agent-test/fixture.txt',
  '      1  added line',
  '      2  ',
  '',
  '   ▶ 1. Approve once',
  '     2. Approve for this session',
  '     3. Reject',
  '     4. Reject with feedback',
  '',
  '   ↑/↓ select · 1/2/3/4 choose · ↵ confirm · ctrl+e preview',
  ' ────────────────────────────────────────────────',
];

describe('the trust prompt', () => {
  const p = readKimiPrompt(TRUST);

  test('its options are read though nothing is numbered', () => {
    expect(p?.options.map((o) => o.label)).toEqual(['Trust this folder', "Don't trust"]);
  });

  test('each carries what it says about itself', () => {
    expect(p?.options.map((o) => o.detail)).toEqual([
      'Enable project MCP servers. Remembered for this folder.',
      'Exit Kimi Code. Asked again next launch.',
    ]);
  });

  test('it is answered by walking the pane, from where the pane is', () => {
    // No digits to type, so the ring walks kimi's own cursor to the row and
    // presses Enter - the path opencode's permission row has used since
    // 0.3.64. The walk is a count of steps, so it needs the starting point.
    expect(p?.choiceInput).toBe('arrow');
    expect(p?.choiceSelected).toBe(0);
  });

  test('the path and the explanation are not options', () => {
    // They sit at a shallower indent than the rows, which is the only thing
    // separating them - the descriptions are at the rows' own column.
    const labels = p?.options.map((o) => o.label).join('|') ?? '';
    expect(labels).not.toContain('/tmp');
    expect(labels).not.toContain('Kimi Code loads');
  });

  test('the question is the line above the hint', () => {
    expect(p?.question).toBe('Trust this folder?');
  });
});

describe('the approval prompt', () => {
  const p = readKimiPrompt(APPROVAL);

  test('the row under the cursor is not the row that goes missing', () => {
    expect(p?.options.map((o) => o.label)).toEqual([
      'Approve once',
      'Approve for this session',
      'Reject',
      'Reject with feedback',
    ]);
  });

  test('`Reject with feedback` is offered, marked as the row that needs saying', () => {
    // Refusing with a reason is a thing to say rather than a thing to pick, and
    // saying it is what the glasses are best at. Picking it sends the digit and
    // starts dictation.
    expect(p?.options.at(-1)).toMatchObject({ label: 'Reject with feedback', freeText: true });
  });

  test('numbered rows answer to their own digit', () => {
    expect(p?.choiceInput).toBe('number');
    expect(p?.choiceSelected).toBeUndefined();
  });

  test('the marker in front of the question is not a cursor', () => {
    // Read as one, it put the column at the question's own indent and the
    // question came back as the first option.
    expect(p?.question).toBe('Write this file?');
    expect(p?.options.map((o) => o.label)).not.toContain('Write this file?');
  });

  test('the diff above the prompt is not part of it', () => {
    const labels = p?.options.map((o) => o.label).join('|') ?? '';
    expect(labels).not.toContain('added line');
  });
});

describe('a pane with no prompt on it', () => {
  test('the composer is not a prompt', () => {
    expect(
      readKimiPrompt([
        '   No session yet — one will be created on your first message.',
        ' ╭────────────────────────────╮',
        ' │ >                          │',
        ' ╰────────────────────────────╯',
        ' moonshotai/kimi-k3  …/scratchpad/agent-test',
      ]),
    ).toBeUndefined();
  });

  test('a rule with no hint line under it is not a prompt', () => {
    expect(
      readKimiPrompt([' ──────────────────────────', '  1. one', '  2. two', ' ──────────────────────────']),
    ).toBeUndefined();
  });
});
