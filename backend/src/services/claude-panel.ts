import { claudeFooterLines } from './claude-footer';

/**
 * A panel Claude Code draws over its input box - what `/usage`, `/model`,
 * `/config` and the like open - read off the screen as text.
 *
 * These write nothing to the transcript: they are screens, moved through with
 * the arrow keys and closed with Esc. So a chat view that only reads the
 * transcript shows nothing at all after one is opened, and the pane sits there
 * waiting for keys nobody can see the need for.
 *
 * ```
 * ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔            <- top edge: the panel starts here
 *   Settings  Status   Config   Usage
 *   Current session
 *   ████████▌             17% used
 *   ↓ to navigate · ←/→ to switch · Esc to close
 * ```
 *
 * Measured on Claude Code under herdr 0.9.5. A panel taller than the screen
 * leaves its footer off and ends in a `↓`. One opened from the settings search
 * can sit above the input box, which is then cut off rather than shown as part
 * of the panel.
 */

const TOP_EDGE = /^\s*▔{20,}\s*$/;
const BOX_RULE = /^\s*─{20,}\s*$/;

export interface ClaudePanel {
  lines: string[];
}

export function parseClaudePanel(screen: string): ClaudePanel | null {
  const lines = screen.split('\n').map((l) => l.replace(/\r$/, '').replace(/\s+$/, ''));
  let top = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TOP_EDGE.test(lines[i] ?? '')) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;

  let end = lines.length;
  if (claudeFooterLines(lines.join('\n'))) {
    // The input box under the panel: its top rule is the second-last rule.
    const rules = lines.flatMap((l, i) => (i > top && BOX_RULE.test(l) ? [i] : []));
    if (rules.length >= 2) end = rules[rules.length - 2]!;
  }

  const body = lines.slice(top + 1, end);
  while (body.length > 0 && body[0]!.trim() === '') body.shift();
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
  if (body.length === 0) return null;

  // Drop the indent every line shares, so a narrow screen is not half margin.
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return { lines: body.map((l) => l.slice(indent)) };
}
