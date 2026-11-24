import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

/**
 * The commands a person has added to Claude Code - their own slash commands
 * and skills, from the user's `~/.claude` and the project's `.claude` - for
 * the chat view's palette. Claude Code's built-in commands are not here: which
 * of them make sense without a terminal is the palette's decision.
 *
 * Plugins are read from Claude Code's own record of what is installed
 * (`~/.claude/plugins/installed_plugins.json`), and listed under the plugin's
 * name (`/plugin:skill`), the way Claude Code itself names them.
 */
export interface SlashCommand {
  name: string;
  description?: string;
  kind: 'command' | 'skill';
  scope: 'user' | 'project' | 'plugin';
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

async function readSkills(root: string, scope: SlashCommand['scope'], prefix = ''): Promise<SlashCommand[]> {
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: SlashCommand[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const text = await readFile(join(root, dir.name, 'SKILL.md'), 'utf-8').catch(() => null);
    if (text === null) continue;
    const meta = parseFrontmatter(text);
    if (meta['user-invocable'] === 'false') continue;
    out.push({ name: prefix + (meta.name || dir.name), description: describe(meta), kind: 'skill', scope });
  }
  return out;
}

/** One skill directory named directly, as a plugin's manifest may list it. */
async function readSkill(dir: string, prefix: string): Promise<SlashCommand[]> {
  const text = await readFile(join(dir, 'SKILL.md'), 'utf-8').catch(() => null);
  if (text === null) return [];
  const meta = parseFrontmatter(text);
  if (meta['user-invocable'] === 'false') return [];
  return [{ name: prefix + (meta.name || basename(dir)), description: describe(meta), kind: 'skill', scope: 'plugin' }];
}

/** `.claude/commands/a/b.md` is `/a:b`. */
async function readCommands(root: string, scope: SlashCommand['scope'], prefix = ''): Promise<SlashCommand[]> {
  const files = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  const out: SlashCommand[] = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const text = await readFile(join(root, file), 'utf-8').catch(() => null);
    if (text === null) continue;
    const name = relative('.', file.slice(0, -3)).split(sep).join(':');
    out.push({ name: prefix + name, description: describe(parseFrontmatter(text)), kind: 'command', scope });
  }
  return out;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(path, 'utf-8').catch(() => null);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const asPaths = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Which plugins are on for this project: `enabledPlugins` from the user's
 * settings, then the project's and its local settings, each overriding the last.
 */
async function enabledPlugins(projectDir: string | null, home: string): Promise<Map<string, boolean>> {
  const files = [join(home, '.claude', 'settings.json')];
  if (projectDir) files.push(join(projectDir, '.claude', 'settings.json'), join(projectDir, '.claude', 'settings.local.json'));
  const out = new Map<string, boolean>();
  for (const file of files) {
    const enabled = (await readJson(file))?.enabledPlugins;
    if (!enabled || typeof enabled !== 'object') continue;
    for (const [key, on] of Object.entries(enabled)) if (typeof on === 'boolean') out.set(key, on);
  }
  return out;
}

/**
 * The commands and skills of every enabled plugin. An install scoped to a
 * project (`project`, `local`) counts only in that project's own directory,
 * which is where Claude Code started from when it was installed there.
 */
async function readPlugins(projectDir: string | null, home: string): Promise<SlashCommand[]> {
  const installed = (await readJson(join(home, '.claude', 'plugins', 'installed_plugins.json')))?.plugins;
  if (!installed || typeof installed !== 'object') return [];
  const enabled = await enabledPlugins(projectDir, home);
  const out: SlashCommand[] = [];
  for (const [key, entries] of Object.entries(installed)) {
    if (enabled.get(key) !== true || !Array.isArray(entries)) continue;
    const entry = entries.find((e) => {
      if (!e || typeof e.installPath !== 'string') return false;
      if (e.scope === 'user') return true;
      return projectDir !== null && typeof e.projectPath === 'string' && resolve(e.projectPath) === resolve(projectDir);
    });
    if (!entry) continue;
    const dir: string = entry.installPath;
    const manifest = (await readJson(join(dir, '.claude-plugin', 'plugin.json'))) ?? {};
    const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : key.split('@')[0]!;
    const prefix = `${name}:`;
    // A manifest's own paths add to the default directories rather than replacing them.
    out.push(...(await readCommands(join(dir, 'commands'), 'plugin', prefix)));
    for (const p of asPaths(manifest.commands)) {
      const at = resolve(dir, p);
      if (at.endsWith('.md')) {
        const text = await readFile(at, 'utf-8').catch(() => null);
        if (text !== null) {
          out.push({ name: prefix + basename(at, '.md'), description: describe(parseFrontmatter(text)), kind: 'command', scope: 'plugin' });
        }
      } else {
        out.push(...(await readCommands(at, 'plugin', prefix)));
      }
    }
    out.push(...(await readSkills(join(dir, 'skills'), 'plugin', prefix)));
    for (const p of asPaths(manifest.skills)) {
      const at = resolve(dir, p);
      const one = await readSkill(at, prefix);
      out.push(...(one.length > 0 ? one : await readSkills(at, 'plugin', prefix)));
    }
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
  found.push(...(await readPlugins(projectDir, home)));
  // A project's own definition shadows the user's of the same name, as in Claude Code.
  const seen = new Set<string>();
  return found
    .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
    .sort((a, b) => a.name.localeCompare(b.name));
}
