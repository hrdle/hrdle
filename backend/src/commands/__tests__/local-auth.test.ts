import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../../shared/identity';
import { AuthService } from '../../services/auth';
import { localAuthHeaders, localUnauthorizedMessage } from '../local-auth';

const DATA_DIR_ENV = IDENTITY.dataDirEnv;
let tempDir: string;
let previous: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'local-auth-'));
  previous = process.env[DATA_DIR_ENV];
  process.env[DATA_DIR_ENV] = tempDir;
});

afterEach(async () => {
  if (previous === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = previous;
  await rm(tempDir, { recursive: true, force: true });
});

describe('localAuthHeaders', () => {
  test('signs a token the server verifies with the same secret', async () => {
    await writeFile(join(tempDir, 'jwt-secret'), 'server-secret\n');
    const headers = await localAuthHeaders();
    const token = headers.Authorization?.replace(/^Bearer /, '');
    expect(token).toBeTruthy();
    const payload = await new AuthService(tempDir, 'server-secret').verifyToken(token as string);
    expect(payload.username).toBe('local-cli');
  });

  test('a server signing with another secret rejects it', async () => {
    await writeFile(join(tempDir, 'jwt-secret'), 'stale-file-secret');
    const token = (await localAuthHeaders()).Authorization?.replace(/^Bearer /, '') as string;
    await expect(new AuthService(tempDir, 'env-secret').verifyToken(token)).rejects.toThrow();
  });

  test('no secret on disk sends no header', async () => {
    expect(await localAuthHeaders()).toEqual({});
  });
});

describe('localUnauthorizedMessage', () => {
  test('names the missing file and JWT_SECRET when nothing is on disk', () => {
    const message = localUnauthorizedMessage();
    expect(message).toContain(join(tempDir, 'jwt-secret'));
    expect(message).toContain('does not exist');
    expect(message).toContain('JWT_SECRET');
  });

  test('names a rejected token and JWT_SECRET when the file exists', async () => {
    await writeFile(join(tempDir, 'jwt-secret'), 'x');
    const message = localUnauthorizedMessage();
    expect(message).toContain('rejected');
    expect(message).toContain('JWT_SECRET');
  });
});
