/**
 * Authorization for the CLI's requests to the server on this host.
 *
 * With a password set, `/api/sessions/*` and most of `/api/glasses/*` need a
 * token, and the CLI has no login. It does not need one: the server's signing
 * secret is a 0600 file owned by the same user, so the CLI signs a token with
 * it. Without a password the header is ignored.
 *
 * A server given `JWT_SECRET` in its environment never writes that file, and
 * the CLI does not inherit the server's environment, so there it has nothing
 * to sign with (or a stale file from an earlier run). `LOCAL_AUTH_HINT` names
 * that case on a 401 rather than leaving "not authorized" with no way out.
 */

import { readFile } from 'node:fs/promises';
import { jwtSecretPath } from '../middleware/auth';
import { AuthService } from '../services/auth';
import { getDataDir } from '../utils/storage';

export const LOCAL_AUTH_HINT =
  'Not authorized: the server has a password set and did not accept the token signed with ' +
  `${jwtSecretPath()}. A server given JWT_SECRET in its environment does not use that file.`;

export async function localAuthHeaders(): Promise<Record<string, string>> {
  let secret: string;
  try {
    secret = (await readFile(jwtSecretPath(), 'utf-8')).trim();
  } catch {
    return {};
  }
  if (!secret) return {};
  const token = await new AuthService(getDataDir(), secret).generateTokenForUser('cli');
  return { Authorization: `Bearer ${token}` };
}
