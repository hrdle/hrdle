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

function isCchubNotify(command: unknown): command is string {
  return typeof command === 'string' && HOOK_COMMAND_PATTERN.test(command.trim());
}

function hasCchubHook(entries: JsonHookEntry[] | undefined, matcher?: string): boolean {
  return !!entries?.some((entry) => {
    if (matcher && entry.matcher !== matcher && !entry.matcher?.includes(matcher)) return false;
    return entry.hooks?.some((hook) => isCchubNotify(hook.command));
  });
}

/** Merge the two CC Hub notification hooks into Codex's canonical hooks.json. */
export function mergeCchubNotifyHooksJson(content: string | null, command: string): string {
  const parsed: CodexHooksJson = content?.trim()
    ? JSON.parse(content) as CodexHooksJson
    : {};
  const hooks = parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : {};

  if (!hasCchubHook(hooks.Stop)) {
    hooks.Stop = [
      ...(Array.isArray(hooks.Stop) ? hooks.Stop : []),
      { hooks: [{ type: 'command', command }] },
    ];
  }
  if (!hasCchubHook(hooks.PostToolUse, 'AskUserQuestion')) {
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

function tomlHeader(line: string): string | null {
  const trimmed = line.trim();
  return trimmed.startsWith('[') ? trimmed : null;
}

function hookEventFromParent(header: string): string | null {
  return header.match(/^\[\[hooks\.([A-Za-z0-9_]+)\]\]$/)?.[1] ?? null;
}

function isNestedHookHeader(header: string, event: string): boolean {
  return header === `[[hooks.${event}.hooks]]`;
}

function blockHasCchubNotify(lines: string[]): boolean {
  return lines.some((line) => {
    const match = line.trim().match(/^command\s*=\s*(["'])(.*?)\1\s*$/);
    return !!match && isCchubNotify(match[2]);
  });
}

/**
 * Remove only hook entries whose command is `cchub notify` from config.toml.
 * Other TOML settings and unrelated hook commands keep their original text.
 */
export function removeCchubNotifyHooksToml(content: string): string {
  const lines = content.split('\n');
  const output: string[] = [];

  for (let index = 0; index < lines.length;) {
    const header = tomlHeader(lines[index] ?? '');
    const event = header ? hookEventFromParent(header) : null;
    if (!event) {
      output.push(lines[index] ?? '');
      index++;
      continue;
    }

    const groupStart = index;
    index++;
    while (index < lines.length) {
      const nextHeader = tomlHeader(lines[index] ?? '');
      if (nextHeader && !isNestedHookHeader(nextHeader, event)) break;
      index++;
    }

    const group = lines.slice(groupStart, index);
    const segments: string[][] = [];
    let current: string[] = [];
    for (const line of group) {
      const segmentHeader = tomlHeader(line);
      if (segmentHeader && isNestedHookHeader(segmentHeader, event) && current.length > 0) {
        segments.push(current);
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) segments.push(current);

    const parent = segments[0] ?? [];
    if (blockHasCchubNotify(parent)) continue;
    const remainingChildren = segments.slice(1).filter((segment) => !blockHasCchubNotify(segment));
    if (remainingChildren.length === 0) continue;
    output.push(...parent, ...remainingChildren.flat());
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function findCchubNotifyCommandInToml(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const match = line.trim().match(/^command\s*=\s*(["'])(.*?)\1\s*$/);
    if (match && isCchubNotify(match[2])) return match[2];
  }
  return undefined;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${IDENTITY.binaryName}-tmp-${process.pid}`;
  await writeFile(tempPath, content, { mode: 0o600 });
  await rename(tempPath, path);
}

export async function migrateCodexHooksToJson(
  codexDir: string,
): Promise<{ changed: boolean; command: string }> {
  const configPath = join(codexDir, 'config.toml');
  const hooksPath = join(codexDir, 'hooks.json');
  const config = await readFile(configPath, 'utf8').catch(() => '');
  const hooksJson = await readFile(hooksPath, 'utf8').catch(() => null);
  // A command already written by hand is kept verbatim — it may be an absolute
  // path the user chose. Only what CC Hub writes itself gets resolved.
  const command = findCchubNotifyCommandInToml(config) ?? resolveNotifyCommand();
  const nextConfig = removeCchubNotifyHooksToml(config);
  const nextHooksJson = mergeCchubNotifyHooksJson(hooksJson, command);
  const changed = nextConfig !== config || nextHooksJson !== hooksJson;

  if (nextConfig !== config) await atomicWrite(configPath, nextConfig);
  if (nextHooksJson !== hooksJson) await atomicWrite(hooksPath, nextHooksJson);
  return { changed, command };
}
