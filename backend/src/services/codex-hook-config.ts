import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveNotifyCommand } from './notify-command';
import { HOOK_COMMAND_PATTERN, IDENTITY } from '../../../shared/identity';

interface JsonHookCommand {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface JsonHookEntry {
  matcher?: string;
  hooks?: JsonHookCommand[];
  [key: string]: unknown;
}

interface CodexHooksJson {
  hooks?: Record<string, JsonHookEntry[]>;
  [key: string]: unknown;
}

function isNotifyCommand(command: unknown): command is string {
  return typeof command === 'string' && HOOK_COMMAND_PATTERN.test(command.trim());
}

function hasNotifyHook(entries: JsonHookEntry[] | undefined, matcher?: string): boolean {
  return !!entries?.some((entry) => {
    if (matcher && entry.matcher !== matcher && !entry.matcher?.includes(matcher)) return false;
    return entry.hooks?.some((hook) => isNotifyCommand(hook.command));
  });
}

/** Merge the two notification hooks into Codex's canonical hooks.json. */
export function mergeNotifyHooksJson(content: string | null, command: string): string {
  const parsed: CodexHooksJson = content?.trim()
    ? JSON.parse(content) as CodexHooksJson
    : {};
  const hooks = parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : {};

  if (!hasNotifyHook(hooks.Stop)) {
    hooks.Stop = [
      ...(Array.isArray(hooks.Stop) ? hooks.Stop : []),
      { hooks: [{ type: 'command', command }] },
    ];
  }
  if (!hasNotifyHook(hooks.PostToolUse, 'AskUserQuestion')) {
    hooks.PostToolUse = [
      ...(Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : []),
      {
        matcher: 'AskUserQuestion',
        hooks: [{ type: 'command', command }],
      },
    ];
  }

  parsed.hooks = hooks;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${IDENTITY.binaryName}-tmp-${process.pid}`;
  await writeFile(tempPath, content, { mode: 0o600 });
  await rename(tempPath, path);
}

/** Install the notification hooks into Codex's canonical hooks.json. */
export async function installCodexNotifyHooks(
  codexDir: string,
): Promise<{ changed: boolean; command: string }> {
  const hooksPath = join(codexDir, 'hooks.json');
  const hooksJson = await readFile(hooksPath, 'utf8').catch(() => null);
  const command = resolveNotifyCommand();
  const nextHooksJson = mergeNotifyHooksJson(hooksJson, command);
  const changed = nextHooksJson !== hooksJson;

  if (changed) await atomicWrite(hooksPath, nextHooksJson);
  return { changed, command };
}
