import { describe, expect, test } from 'bun:test';
import { envFileContent } from '../../src/commands/setup';
import { isAuthRequired, getServerPassword } from '../../src/middleware/auth';
import { IDENTITY, PASSWORD_ENV } from '../../../shared/identity';

/**
 * The env file `setup` writes and the variable startup reads have to be the
 * same name. They were not: setup wrote `PASSWORD=` while the server read
 * `HRDLE_PASSWORD`, so a password configured on Linux was never seen and the
 * server ran unauthenticated while reporting itself as configured. Neither side
 * fails on its own, so the agreement is asserted here instead.
 */
describe('service password environment variable', () => {
  test('the env file writes the name the auth layer reads', () => {
    expect(envFileContent('s3cret')).toBe(`${PASSWORD_ENV}=s3cret\n`);
    expect(envFileContent()).toBe(`# ${PASSWORD_ENV}=yourpassword\n`);
  });

  test('the name is derived from the binary, not spelled out', () => {
    expect(PASSWORD_ENV).toBe(`${IDENTITY.binaryName.toUpperCase()}_PASSWORD`);
  });

  test('auth reads that variable and nothing else', () => {
    const prev = process.env[PASSWORD_ENV];
    try {
      delete process.env[PASSWORD_ENV];
      expect(isAuthRequired()).toBe(false);
      process.env[PASSWORD_ENV] = 'from-env-file';
      expect(isAuthRequired()).toBe(true);
      expect(getServerPassword()).toBe('from-env-file');
    } finally {
      if (prev === undefined) delete process.env[PASSWORD_ENV];
      else process.env[PASSWORD_ENV] = prev;
    }
  });

  test('the password variable is namespaced, never a bare PASSWORD', () => {
    // A bare name would switch auth on with a password the user never chose
    // for this server, picked up out of the ambient environment.
    expect(PASSWORD_ENV).toBe('HRDLE_PASSWORD');
  });
});
