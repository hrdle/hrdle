import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveNotifyCommand } from './notify-command';
import { HOOK_COMMAND } from '../../../shared/identity';

/**
 * Hooks CC Hub still needs. Indicator transitions used to need PreToolUse and
 * UserPromptSubmit too; herdr reports agent status itself now (#390), so those
 * are no longer expected — flagging their absence would be a false alarm.
 * What's left is what herdr can't give us: the notification text (Stop) and the
 * name of the tool a question came from (PostToolUse/AskUserQuestion).
 */
type HookEventStatus = {
  stop: boolean;
  askUserQuestion: boolean;
};

type HookEntry = { matcher?: string; hooks?: Array<{ command?: string }> };

type HookProviderStatus = {
  configured: boolean;
  events: HookEventStatus;
  missing: Array<keyof HookEventStatus>;
};

type HookStatus = HookProviderStatus & {
  providers: {
    claude: HookProviderStatus;
    codex: HookProviderStatus;
    grok: HookProviderStatus;
  };
  /**
   * The invocation a client should write into a hook config. Only this side
   * knows where the running binary lives, and a hook shell's PATH usually
   * doesn't (#538).
   */
  command: string;
};

const DEFAULT_EVENTS: HookEventStatus = {
  stop: false,
  askUserQuestion: false,
};

function cloneDefaultEvents(): HookEventStatus {
  return { ...DEFAULT_EVENTS };
}

function finalizeHookStatus(events: HookEventStatus): HookProviderStatus {
  const missing = Object.entries(events)
    .filter(([, ok]) => !ok)
    .map(([key]) => key as keyof HookEventStatus);
  return {
    configured: missing.length === 0,
    events,
    missing,
  };
}

function matcherMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  return actual === expected || actual.includes(expected);
}

function hasCchubNotify(entries: HookEntry[] | undefined, matcher?: string): boolean {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (matcher !== undefined && !matcherMatches(entry.matcher, matcher)) continue;
    for (const hook of entry.hooks || []) {
      if (hook.command?.includes(HOOK_COMMAND)) return true;
    }
  }
  return false;
}

export function parseHookJson(content: string): HookEventStatus | null {
  try {
    const settings = JSON.parse(content);
    const hooks = (settings.hooks || {}) as Record<string, HookEntry[]>;

    return {
      stop: hasCchubNotify(hooks.Stop),
      askUserQuestion: hasCchubNotify(hooks.PostToolUse, 'AskUserQuestion'),
    };
  } catch {
    return null;
  }
}

function unquoteTomlString(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseHookToml(content: string): HookEventStatus | null {
  const events = cloneDefaultEvents();
  let currentEvent: keyof HookEventStatus | null = null;
  let currentMatcher: string | null = null;
  let inHookItems = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Any section header ends the previous one. Sections we don't track
    // (PreToolUse etc.) must clear currentEvent, or their `cchub notify` line
    // would be credited to whichever hook was parsed before them.
    if (line.startsWith('[')) {
      const sectionMatch = line.match(/^\[\[hooks\.(Stop|PostToolUse)(?:\.hooks)?\]\]$/);
      currentEvent = sectionMatch
        ? sectionMatch[1] === 'Stop'
          ? 'stop'
          : 'askUserQuestion'
        : null;
      inHookItems = !!sectionMatch && line.includes('.hooks]]');
      if (!inHookItems) {
        currentMatcher = null;
      }
      continue;
    }

    if (currentEvent === null) continue;

    const matcherMatch = line.match(/^matcher\s*=\s*(.+)$/);
    if (matcherMatch) {
      currentMatcher = unquoteTomlString(matcherMatch[1]);
      continue;
    }

    if (!inHookItems && !line.startsWith('command')) continue;
    if (!line.includes('command') || !line.includes(HOOK_COMMAND)) continue;

    if (currentEvent === 'askUserQuestion') {
      if (matcherMatches(currentMatcher ?? undefined, 'AskUserQuestion')) {
        events.askUserQuestion = true;
      }
      continue;
    }

    events[currentEvent] = true;
  }

  return events;
}

async function readHookFile(path: string): Promise<HookEventStatus | null> {
  try {
    const content = await readFile(path, 'utf-8');
    if (path.endsWith('.json')) {
      return parseHookJson(content);
    }
    if (path.endsWith('.toml')) {
      return parseHookToml(content);
    }
    return null;
  } catch {
    return null;
  }
}

async function getProviderStatus(paths: string[]): Promise<HookProviderStatus> {
  const aggregated = cloneDefaultEvents();

  for (const path of paths) {
    const events = await readHookFile(path);
    if (!events) continue;
    aggregated.stop ||= events.stop;
    aggregated.askUserQuestion ||= events.askUserQuestion;
  }

  return finalizeHookStatus(aggregated);
}

/** All .json files in a directory (for Grok's native `~/.grok/hooks/`). */
async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith('.json')).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export async function getHookStatus(): Promise<HookStatus> {
  const cwd = process.cwd();
  const claudePaths = [
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'hooks.json'),
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude', 'hooks.json'),
  ];
  const claude = await getProviderStatus(claudePaths);
  const codex = await getProviderStatus([
    join(cwd, '.codex', 'config.toml'),
    join(cwd, '.codex', 'hooks.json'),
    join(homedir(), '.codex', 'config.toml'),
    join(homedir(), '.codex', 'hooks.json'),
  ]);
  // Grok Build scans Claude's settings.json hooks by default (compat layer),
  // plus its own native hook files (same JSON shape as Claude's settings).
  const grok = await getProviderStatus([
    ...claudePaths,
    ...(await listJsonFiles(join(homedir(), '.grok', 'hooks'))),
  ]);

  const providers = { claude, codex, grok };
  const providerList = Object.values(providers);
  const events = {
    stop: providerList.some((p) => p.events.stop),
    askUserQuestion: providerList.some((p) => p.events.askUserQuestion),
  };

  const missing = Object.entries(events)
    .filter(([, ok]) => !ok)
    .map(([key]) => key as keyof HookEventStatus);

  return {
    configured: providerList.some((p) => p.configured),
    events,
    missing,
    providers,
    command: resolveNotifyCommand(),
  };
}
