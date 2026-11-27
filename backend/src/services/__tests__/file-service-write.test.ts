import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConflictError, FileService, hashContent } from '../file-service';

const service = new FileService();
let base: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'fs-write-base-'));
  outside = await mkdtemp(join(tmpdir(), 'fs-write-outside-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('readFile hash', () => {
  it('carries the hash of a text file read in full', async () => {
    await writeFile(join(base, 'a.txt'), 'hello');
    const file = await service.readFile(join(base, 'a.txt'), base);
    expect(file.hash).toBe(hashContent(Buffer.from('hello')));
  });

  it('carries no hash when the read was truncated', async () => {
    await writeFile(join(base, 'a.txt'), 'hello world');
    const file = await service.readFile(join(base, 'a.txt'), base, 4);
    expect(file.truncated).toBe(true);
    expect(file.hash).toBeUndefined();
  });
});

describe('writeTextFile', () => {
  it('saves over the file that was read', async () => {
    const path = join(base, 'a.txt');
    await writeFile(path, 'old');
    const result = await service.writeTextFile(path, 'new', hashContent(Buffer.from('old')), base);
    expect(await readFile(path, 'utf-8')).toBe('new');
    expect(result.hash).toBe(hashContent(Buffer.from('new')));
  });

  it('refuses when the file changed since it was read', async () => {
    const path = join(base, 'a.txt');
    await writeFile(path, 'changed by the agent');
    const err = await service
      .writeTextFile(path, 'mine', hashContent(Buffer.from('old')), base)
      .catch((e) => e);
    expect(err).toBeInstanceOf(FileConflictError);
    expect(err.currentHash).toBe(hashContent(Buffer.from('changed by the agent')));
    expect(await readFile(path, 'utf-8')).toBe('changed by the agent');
  });

  it('creates a new file only when it does not exist yet', async () => {
    const path = join(base, 'new.txt');
    await service.writeTextFile(path, 'x', null, base);
    expect(await readFile(path, 'utf-8')).toBe('x');
    const err = await service.writeTextFile(path, 'y', null, base).catch((e) => e);
    expect(err).toBeInstanceOf(FileConflictError);
  });

  it('keeps the mode of an executable file', async () => {
    const path = join(base, 'run.sh');
    await writeFile(path, 'echo 1');
    await chmod(path, 0o755);
    await service.writeTextFile(path, 'echo 2', hashContent(Buffer.from('echo 1')), base);
    expect((await stat(path)).mode & 0o777).toBe(0o755);
  });

  it('writes through a symlink and leaves the link in place', async () => {
    const real = join(base, 'real.txt');
    const link = join(base, 'link.txt');
    await writeFile(real, 'a');
    await symlink(real, link);
    await service.writeTextFile(link, 'b', hashContent(Buffer.from('a')), base);
    expect(await readlink(link)).toBe(real);
    expect(await readFile(real, 'utf-8')).toBe('b');
  });

  it('refuses a path outside the base', async () => {
    const err = await service.writeTextFile(join(outside, 'x.txt'), 'x', null, base).catch((e) => e);
    expect(err.message).toContain('Access denied');
  });
});

describe('renamePath', () => {
  it('moves a file into another directory', async () => {
    await writeFile(join(base, 'a.txt'), 'a');
    await mkdir(join(base, 'sub'));
    await service.renamePath(join(base, 'a.txt'), join(base, 'sub', 'b.txt'), base);
    expect(await readFile(join(base, 'sub', 'b.txt'), 'utf-8')).toBe('a');
  });

  it('refuses to replace an existing file', async () => {
    await writeFile(join(base, 'a.txt'), 'a');
    await writeFile(join(base, 'b.txt'), 'b');
    const err = await service.renamePath(join(base, 'a.txt'), join(base, 'b.txt'), base).catch((e) => e);
    expect(err).toBeInstanceOf(FileConflictError);
    expect(await readFile(join(base, 'b.txt'), 'utf-8')).toBe('b');
  });

  it('refuses a destination outside the base', async () => {
    await writeFile(join(base, 'a.txt'), 'a');
    const err = await service.renamePath(join(base, 'a.txt'), join(outside, 'a.txt'), base).catch((e) => e);
    expect(err.message).toContain('Access denied');
  });
});

describe('deletePath', () => {
  it('deletes a file and an empty directory', async () => {
    await writeFile(join(base, 'a.txt'), 'a');
    await mkdir(join(base, 'empty'));
    await service.deletePath(join(base, 'a.txt'), base);
    await service.deletePath(join(base, 'empty'), base);
    expect(await lstat(join(base, 'a.txt')).catch((e) => e.code)).toBe('ENOENT');
    expect(await lstat(join(base, 'empty')).catch((e) => e.code)).toBe('ENOENT');
  });

  it('refuses a directory with something in it', async () => {
    await mkdir(join(base, 'full'));
    await writeFile(join(base, 'full', 'x'), 'x');
    const err = await service.deletePath(join(base, 'full'), base).catch((e) => e);
    expect(err.code).toBe('ENOTEMPTY');
  });

  it('removes a symlink, not what it points at', async () => {
    await writeFile(join(outside, 'target.txt'), 't');
    await symlink(join(outside, 'target.txt'), join(base, 'link'));
    await service.deletePath(join(base, 'link'), base);
    expect(await readFile(join(outside, 'target.txt'), 'utf-8')).toBe('t');
  });

  it('refuses the base itself', async () => {
    const err = await service.deletePath(base, base).catch((e) => e);
    expect(err.message).toContain('Access denied');
  });
});
