import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSlashCommands, parseFrontmatter } from '../slash-commands';

const root = mkdtempSync(join(tmpdir(), 'slash-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

describe('parseFrontmatter', () => {
  test('reads flat values, quoted values and block scalars', () => {
    const meta = parseFrontmatter('---\nname: a\ndescription: >\n  one\n  two\nx: "q"\n---\nbody');
    expect(meta).toEqual({ name: 'a', description: 'one two', x: 'q' });
  });

  test('is empty without frontmatter', () => {
    expect(parseFrontmatter('# title')).toEqual({});
  });
});

describe('listSlashCommands', () => {
  write('home/.claude/skills/release/SKILL.md', '---\nname: release\ndescription: user release\n---\n');
  write('home/.claude/skills/hidden/SKILL.md', '---\nname: hidden\nuser-invocable: false\n---\n');
  write('home/.claude/commands/git/sync.md', '---\ndescription: sync it\n---\n');
  write('proj/.claude/skills/release/SKILL.md', '---\nname: release\ndescription: project release\n---\n');
  write('proj/.claude/commands/notes.md', 'no frontmatter\n');

  test('lists commands and skills, project first, skipping what is not user-invocable', async () => {
    const list = await listSlashCommands(join(root, 'proj'), join(root, 'home'));
    expect(list).toEqual([
      { name: 'git:sync', description: 'sync it', kind: 'command', scope: 'user' },
      { name: 'notes', description: undefined, kind: 'command', scope: 'project' },
      { name: 'release', description: 'project release', kind: 'skill', scope: 'project' },
    ]);
  });

  test('a missing directory is an empty list, not an error', async () => {
    expect(await listSlashCommands(join(root, 'nowhere'), join(root, 'nobody'))).toEqual([]);
  });
});

describe('listSlashCommands with plugins', () => {
  const home = 'phome';
  const plugin = (name: string) => join(root, home, '.claude/plugins/cache/m', name);
  write(`${home}/.claude/settings.json`, JSON.stringify({ enabledPlugins: { 'a@m': true, 'off@m': false, 'mine@m': true } }));
  write(`${home}/.claude/plugins/installed_plugins.json`, JSON.stringify({
    version: 2,
    plugins: {
      'a@m': [{ scope: 'user', installPath: plugin('a') }],
      'off@m': [{ scope: 'user', installPath: plugin('off') }],
      'mine@m': [{ scope: 'local', projectPath: join(root, 'pproj'), installPath: plugin('mine') }],
      'there@m': [{ scope: 'project', projectPath: join(root, 'pproj'), installPath: plugin('there') }],
    },
  }));
  write(`${home}/.claude/plugins/cache/m/a/.claude-plugin/plugin.json`, JSON.stringify({ name: 'alpha', skills: ['./extra/one'] }));
  write(`${home}/.claude/plugins/cache/m/a/skills/build/SKILL.md`, '---\nname: build\ndescription: builds\n---\n');
  write(`${home}/.claude/plugins/cache/m/a/skills/quiet/SKILL.md`, '---\nname: quiet\nuser-invocable: false\n---\n');
  write(`${home}/.claude/plugins/cache/m/a/extra/one/SKILL.md`, '---\nname: one\n---\n');
  write(`${home}/.claude/plugins/cache/m/a/commands/run.md`, '---\ndescription: runs\n---\n');
  write(`${home}/.claude/plugins/cache/m/off/skills/x/SKILL.md`, '---\nname: x\n---\n');
  write(`${home}/.claude/plugins/cache/m/mine/skills/y/SKILL.md`, '---\nname: y\n---\n');
  write(`${home}/.claude/plugins/cache/m/there/skills/z/SKILL.md`, '---\nname: z\n---\n');
  write('pproj/.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'there@m': true } }));

  test('lists enabled plugins under their own name, from the manifest paths too', async () => {
    const names = (await listSlashCommands(join(root, 'elsewhere'), join(root, home))).map((c) => c.name);
    expect(names).toEqual(['alpha:build', 'alpha:one', 'alpha:run']);
  });

  test('counts a project-scoped install only in that project, with its own settings', async () => {
    const list = await listSlashCommands(join(root, 'pproj'), join(root, home));
    expect(list.map((c) => c.name)).toEqual(['alpha:build', 'alpha:one', 'alpha:run', 'mine:y', 'there:z']);
    expect(list.find((c) => c.name === 'alpha:build')).toEqual({
      name: 'alpha:build',
      description: 'builds',
      kind: 'skill',
      scope: 'plugin',
    });
  });
});
