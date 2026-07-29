import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthService } from '../../src/services/auth';
import { IDENTITY } from '../../../shared/identity';

// Regression for #230: the JWT signing secret must never fall back to a
// guessable hardcoded default. initJwtSecret() generates and persists a random
// secret (0600) when neither JWT_SECRET env nor a persisted secret exists.

const TEST_DATA_DIR = join(import.meta.dir, '.test-data-jwt');
const OLD_HARDCODED_DEFAULT = 'development-secret-change-in-production';

let initJwtSecret: () => Promise<void>;
let getJwtSecret: () => string;

beforeAll(async () => {
  delete process.env.JWT_SECRET;
  // From identity: a spelled-out variable stops redirecting the data directory
  // when it is renamed (#459), and the generated secret lands in the real one.
  process.env[IDENTITY.dataDirEnv] = TEST_DATA_DIR;
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  // Import after env setup so the module's secret starts uninitialized.
  ({ initJwtSecret, getJwtSecret } = await import('../../src/middleware/auth'));
});

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('jwt secret (initJwtSecret / getJwtSecret)', () => {
  test('getJwtSecret throws before initialization', () => {
    expect(() => getJwtSecret()).toThrow();
  });

  test('initJwtSecret generates a 64-hex secret persisted with mode 0600', async () => {
    await initJwtSecret();
    const secret = getJwtSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const st = await stat(join(TEST_DATA_DIR, 'jwt-secret'));
    expect(st.mode & 0o777).toBe(0o600);
  });

  test('a second initJwtSecret call returns the same persisted secret', async () => {
    const first = getJwtSecret();
    await initJwtSecret();
    expect(getJwtSecret()).toBe(first);
  });

  test('no usable default: a token signed with the old hardcoded secret is rejected', async () => {
    const secret = getJwtSecret();
    const attacker = new AuthService(TEST_DATA_DIR, OLD_HARDCODED_DEFAULT);
    const forged = await attacker.generateTokenForUser('attacker');

    await expect(new AuthService(TEST_DATA_DIR, secret).verifyToken(forged)).rejects.toThrow();
  });

  test('a token signed with the resolved secret verifies', async () => {
    const secret = getJwtSecret();
    const svc = new AuthService(TEST_DATA_DIR, secret);
    const token = await svc.generateTokenForUser('alice');
    const payload = await svc.verifyToken(token);
    expect(payload.username).toBe('alice');
  });
});
