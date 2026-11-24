import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

/**
 * The commands a person has added to Claude Code - their own slash commands
 * and skills, from the user's `~/.claude` and the project's `.claude` - for
 * the chat view's palette. Claude Code's built-in commands are not here: which
 * of them make sense without a terminal is the palette's decision.
 *
 * Plugin skills are not read: where a plugin keeps them depends on how it was
 * installed, and a palette that lists some plugins and not others is worse
 * than one that lists none.
 */
export interface SlashCommand {
  name: string;
  description?: string;
  kind: 'command' | 'skill';
  scope: 'user' | 'project';
}

const DESCRIPTION_MAX = 200;

/** The frontmatter's flat `key: value` pairs. Block scalars take their indented lines. */
export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return out;
  const lines = text.slice(text.indexOf('\n') + 1, end).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? '');
    if (!m) continue;
    let value = (m[2] ?? '').trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? '')) block.push((lines[++i] ?? '').trim());
      value = block.join(' ');
    }
    out[m[1]!] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function describe(meta: Record<string, string>): string | undefined {
  const d = meta.description?.trim();
  if (!d) return undefined;
  return d.length > DESCRIPTION_MAX ? `${d.slice(0, DESCRIPTION_MAX - 1)}…` : d;
}

async function readSkills(root: string, scope: SlashCommand['scope']): Promise<SlashCommand[]> {
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: SlashCommand[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const text = await readFile(join(root, dir.name, 'SKILL.md'), 'utf-8').catch(() => null);
    if (text === null) continue;
    const meta = parseFrontmatter(text);
    if (meta['user-invocable'] === 'false') continue;
    out.push({ name: meta.name || dir.name, description: describe(meta), kind: 'skill', scope });
  }
  return out;
}

/** `.claude/commands/a/b.md` is `/a:b`. */
async function readCommands(root: string, scope: SlashCommand['scope']): Promise<SlashCommand[]> {
  const files = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  const out: SlashCommand[] = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const text = await readFile(join(root, file), 'utf-8').catch(() => null);
    if (text === null) continue;
    const name = relative('.', file.slice(0, -3)).split(sep).join(':');
    out.push({ name, description: describe(parseFrontmatter(text)), kind: 'command', scope });
  }
  return out;
}

export async function listSlashCommands(projectDir: string | null, home = homedir()): Promise<SlashCommand[]> {
  const roots: Array<[string, SlashCommand['scope']]> = [[join(home, '.claude'), 'user']];
  if (projectDir && projectDir !== home) roots.unshift([join(projectDir, '.claude'), 'project']);
  const found: SlashCommand[] = [];
  for (const [root, scope] of roots) {
    found.push(...(await readCommands(join(root, 'commands'), scope)));
    found.push(...(await readSkills(join(root, 'skills'), scope)));
  }
  // A project's own definition shadows the user's of the same name, as in Claude Code.
  const seen = new Set<string>();
  return found
    .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
    .sort((a, b) => a.name.localeCompare(b.name));
}
