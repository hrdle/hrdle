import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IDENTITY } from '../../../../shared/identity';
import { AuthService } from '../../services/auth';
import { localAuthHeaders } from '../local-auth';

const TEST_DATA_DIR = join(import.meta.dir, '.test-data-local-auth');
const SECRET = 'a'.repeat(64);

let previousDataDir: string | undefined;

beforeAll(async () => {
  previousDataDir = process.env[IDENTITY.dataDirEnv];
  process.env[IDENTITY.dataDirEnv] = TEST_DATA_DIR;
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  await mkdir(TEST_DATA_DIR, { recursive: true });
});

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env[IDENTITY.dataDirEnv];
  else process.env[IDENTITY.dataDirEnv] = previousDataDir;
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function bearer(headers: Record<string, string>): string {
  expect(headers.Authorization).toStartWith('Bearer ');
  return headers.Authorization.slice('Bearer '.length);
}

describe('localAuthHeaders', () => {
  test('signs with the persisted secret, so the server verifies it', async () => {
    await writeFile(join(TEST_DATA_DIR, 'jwt-secret'), `${SECRET}\n`);
    const token = bearer(await localAuthHeaders());
    const payload = await new AuthService(TEST_DATA_DIR, SECRET).verifyToken(token);
    expect(payload.username).toBe('cli');
  });

  test('a server using another secret rejects it', async () => {
    await writeFile(join(TEST_DATA_DIR, 'jwt-secret'), SECRET);
    const token = bearer(await localAuthHeaders());
    await expect(new AuthService(TEST_DATA_DIR, 'b'.repeat(64)).verifyToken(token)).rejects.toThrow();
  });

  test('no secret file means no header rather than a throw', async () => {
    await rm(join(TEST_DATA_DIR, 'jwt-secret'), { force: true });
    expect(await localAuthHeaders()).toEqual({});
  });
});
