/**
 * Authorization for CLI commands calling this host's own server.
 *
 * With a password set, every `/api/sessions/*` route wants a token. The CLI
 * runs as the same user as the server, so it can read the server's signing
 * secret and sign one itself - no password prompt, no new secret, and no
 * unauthenticated route added for local callers.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthService } from '../services/auth';
import { getDataDir } from '../utils/storage';

const CLI_USER = 'local-cli';

function secretPath(): string {
  return join(getDataDir(), 'jwt-secret');
}

function readSecret(): string | null {
  try {
    return readFileSync(secretPath(), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * `Authorization` for a request to the local server, or nothing when there is
 * no secret on disk to sign with. Harmless without a password: the server
 * ignores the header then.
 */
export async function localAuthHeaders(): Promise<Record<string, string>> {
  const secret = readSecret();
  if (!secret) return {};
  const token = await new AuthService(getDataDir(), secret).generateTokenForUser(CLI_USER);
  return { Authorization: `Bearer ${token}` };
}

/**
 * What to say when the local server still answers 401.
 *
 * `JWT_SECRET` in the server's environment is the one case signing cannot
 * cover: the server then never writes the file (or signs with something other
 * than a file left from an earlier run), and a CLI does not inherit the
 * service's environment.
 */
export function localUnauthorizedMessage(): string {
  const path = secretPath();
  return readSecret()
    ? `Not authorized: the server rejected a token signed with ${path}. A server started with JWT_SECRET in its environment signs with that instead, which this command cannot read`
    : `Not authorized: the server has a password set and ${path} does not exist. A server started with JWT_SECRET in its environment never writes it, so this command cannot sign a token`;
}
