import { claudeFooterLines } from './claude-footer';

/**
 * Claude Code's permission mode, as its footer names it.
 *
 * Shift+Tab cycles it and nothing else sets it from outside, so the footer is
 * both where the current mode is read and how a change is confirmed. Measured
 * on Claude Code under herdr 0.9.5, the cycle runs manual, accept edits, plan,
 * auto, and bypass joins it only when the session was started allowing it.
 */
export type ClaudeMode = 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'bypass';

const MODE_WORDS: Array<[RegExp, ClaudeMode]> = [
  [/\bmanual mode on\b/, 'manual'],
  [/\baccept edits on\b/, 'acceptEdits'],
  [/\bplan mode on\b/, 'plan'],
  [/\bauto mode on\b/, 'auto'],
  [/\bbypass permissions on\b/, 'bypass'],
];

/** The mode the footer shows, or null when the screen shows no input box. */
export function parseClaudeMode(screen: string): ClaudeMode | null {
  const footer = claudeFooterLines(screen);
  if (!footer) return null;
  for (const line of footer) {
    for (const [words, mode] of MODE_WORDS) {
      if (words.test(line)) return mode;
    }
  }
  // Older builds show nothing for the default mode.
  return 'manual';
}

/** Presses before giving up: one full cycle plus bypass, plus one for a press the TUI dropped. */
const MAX_PRESSES = 6;
const SETTLE_MS = 250;

export interface ModeIo {
  read: () => Promise<string | null>;
  pressShiftTab: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Press Shift+Tab until the footer shows `target`, reading it after each
 * press rather than counting presses: the cycle's length depends on how the
 * session was started, and a count computed in advance lands on the wrong mode
 * the first time one is missing.
 */
export async function cycleToMode(
  target: ClaudeMode,
  io: ModeIo,
): Promise<{ ok: true; mode: ClaudeMode } | { ok: false; mode: ClaudeMode | null; error: string }> {
  const first = await io.read();
  let mode = first ? parseClaudeMode(first) : null;
  if (mode === null) return { ok: false, mode, error: 'The pane is not showing its input box' };
  for (let i = 0; i < MAX_PRESSES && mode !== target; i++) {
    await io.pressShiftTab();
    await io.sleep(SETTLE_MS);
    const screen = await io.read();
    mode = screen ? parseClaudeMode(screen) : null;
    if (mode === null) return { ok: false, mode, error: 'The pane stopped showing its input box' };
  }
  if (mode !== target) return { ok: false, mode, error: `This session does not offer ${target}` };
  return { ok: true, mode };
}
