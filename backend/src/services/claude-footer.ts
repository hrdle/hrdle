/**
 * Background work, as Claude Code's own footer counts it.
 *
 * The last line of its screen reads `auto mode on · 1 shell` while a
 * background command is running (measured on Claude Code under herdr 0.9.5),
 * and that line is the only place the count is published: the transcript
 * records each start and stop, so a count from it has to replay every one and
 * is wrong the moment one is missed.
 *
 * The footer is whatever sits under the input box's bottom rule. Anything above
 * it is the conversation or the prompt being typed, where "2 shells" is just
 * words somebody wrote.
 */
const RULE = /^[\s─━]*[─━]{10,}[\s─━]*$/;
const COUNT = /^\d+ [a-z]+(?: [a-z]+)?$/;
const FOOTER_MAX_LINES = 4;

/**
 * The lines under the input box's bottom rule, or null when the screen is not
 * showing the input box.
 */
export function claudeFooterLines(screen: string): string[] | null {
  const lines = screen.split('\n').map((l) => l.replace(/\r$/, ''));
  let rule = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE.test(lines[i] ?? '')) {
      rule = i;
      break;
    }
  }
  if (rule < 0) return null;
  const footer = lines.slice(rule + 1).filter((l) => l.trim().length > 0);
  // A screen whose last rule is far above the bottom is not showing the input
  // box at all - a dialog, a full-screen diff - and what follows is not a footer.
  if (footer.length === 0 || footer.length > FOOTER_MAX_LINES) return null;
  return footer;
}

export function parseClaudeBackground(screen: string): string[] {
  const footer = claudeFooterLines(screen);
  if (!footer) return [];
  const out: string[] = [];
  for (const line of footer) {
    for (const part of line.split('·')) {
      const text = part.trim();
      if (COUNT.test(text)) out.push(text);
    }
  }
  return out;
}

const REFRESH_AFTER_MS = 10_000;

/**
 * The count per pane, read off the list's critical path.
 *
 * Reading every Claude pane's screen took 110ms for 22 panes (measured), and
 * the session list is rebuilt every five seconds and on every status change.
 * So a build takes whatever was read last and starts the next read without
 * waiting for it; a badge is at most one refresh behind.
 */
export class ClaudeBackgroundReader {
  private cache = new Map<string, { at: number; value: string[]; reading: boolean }>();

  constructor(private readScreen: (herdrPaneId: string) => Promise<string | null>) {}

  get(herdrPaneId: string, now: number): string[] {
    let entry = this.cache.get(herdrPaneId);
    if (!entry) {
      entry = { at: 0, value: [], reading: false };
      this.cache.set(herdrPaneId, entry);
    }
    if (!entry.reading && now - entry.at >= REFRESH_AFTER_MS) {
      entry.reading = true;
      const target = entry;
      void this.readScreen(herdrPaneId)
        .then((screen) => {
          target.value = screen ? parseClaudeBackground(screen) : [];
        })
        .catch(() => {
          target.value = [];
        })
        .finally(() => {
          target.at = Date.now();
          target.reading = false;
        });
    }
    return entry.value;
  }

  retain(livePaneIds: Set<string>): void {
    for (const id of this.cache.keys()) {
      if (!livePaneIds.has(id)) this.cache.delete(id);
    }
  }
}
