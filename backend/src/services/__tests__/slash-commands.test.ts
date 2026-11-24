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
