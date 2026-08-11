/**
 * Backend-agnostic helpers for inspecting rendered pane content.
 * Used by peer-dialog tooling (`hrdle send --wait`, `hrdle peek`).
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes by design.
const ANSI_RE = /\x1b\[[\d;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export type DetectedPaneState =
  | 'permission_prompt'   // Claude Code permission dialog visible
  | 'ask_user_question'   // AskUserQuestion (numbered choice) dialog visible
  | 'processing'          // Claude Code "Esc to interrupt" / spinner visible
  | 'idle'                // Claude Code prompt visible, idle ✳ marker
  | 'unknown';            // nothing decisive found in viewport

/**
 * Best-effort detection of what state the pane is currently in, based purely
 * on the rendered viewport. Used by peer-dialog tools (`hrdle send --wait`,
 * `hrdle peek`) so the sender can disambiguate idle vs. permission-prompt vs.
 * mid-processing — `indicatorState` from hooks is too coarse for this.
 *
 * Heuristics are based on patterns Claude Code prints. They will need updating
 * if Claude Code's TUI changes. Detection is intentionally non-authoritative;
 * 'unknown' is fine.
 */
export function detectPaneState(lines: string[]): DetectedPaneState {
  // Walk the last ~25 visible rows (where prompts always live).
  const tail = lines.slice(-25).map(stripAnsi);
  const joined = tail.join('\n');

  // Permission prompt — Claude Code's confirm dialog.
  // Examples: "Do you want to proceed?", "1. Yes", "Yes, and don't ask again"
  if (
    /Do you want to (proceed|make this edit|create)/i.test(joined) ||
    /Yes, and don'?t ask again/i.test(joined) ||
    /^\s*❯?\s*[12]\.\s+(Yes|No)\b/m.test(joined)
  ) {
    return 'permission_prompt';
  }

  // AskUserQuestion — numbered choice list, distinguishable from permission
  // by lacking the Yes/No structure and usually having ≥3 options.
  if (/^\s*❯?\s*[1-9][.)]\s+\S/m.test(joined) && /\?\s*$/m.test(joined)) {
    return 'ask_user_question';
  }

  // Processing — Claude Code spinner has these signatures, in priority order.
  // The spinner verb changes per release (Kneading, Brewing, Channeling, …);
  // we match its structure rather than the verb itself.
  //
  // Watch out for narrow panes (≤60 cols): Claude truncates "(esc to
  // interrupt)" to "esc to int…", so we also accept the truncated form.
  if (
    // "esc to interrupt" — with or without parens, full or truncated to "int…"
    /esc\s+to\s+int/i.test(joined) ||
    // Queued input shows up when you send while Claude is busy.
    /Press up to edit queued messages/i.test(joined) ||
    /tokens(?:\s*·[^)]*)?\)/m.test(joined) ||
    // "✻ Channeling…" / "✳ Pondering…" — marker + verb-ing + ellipsis on the
    // same line means the spinner is animating (current task in progress).
    // Stop at the ellipsis to avoid swallowing past-tense "✻ Sautéed for 1m".
    /^\s*[✳✻✶✴]\s+\S+…/m.test(joined)
  ) {
    return 'processing';
  }

  // Idle — Claude prints "✻/✳/✶ <verb>"-prefixed status line above the input
  // box (✻ = completed task, ✳ = idle waiting), or the input box is visible
  // and empty ("│ > " or "❯ " alone on a line). If the spinner check above
  // didn't match and we still see Claude's mode-hint footer, we treat it as
  // idle by default.
  if (
    /^\s*[✳✻✶✴]\s/m.test(joined) ||
    /^\s*│\s+>\s*$/m.test(joined) ||
    /^\s*❯\s*$/m.test(joined) ||
    /⏵⏵\s+(auto mode|accept edits|plan mode)/.test(joined)
  ) {
    return 'idle';
  }

  return 'unknown';
}
