/**
 * peer-auth: logs in to a peer (worker) on the user's behalf.
 *
 * - When a peer is registered the hub POSTs the user's password to /api/auth/login
 * - The JWT that comes back is stored and used for later API/WS calls
 * - A 401 is recorded as the "unauthorized" state, prompting the user to re-authenticate
 */

import { recordPeerFailure, recordPeerSuccess } from './peer-registry';
import { isSafePeerUrl } from './peer-url';

const VERIFY_TIMEOUT_MS = 5_000;

export class PeerAuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'PeerAuthError';
  }
}

function normalizePeerUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

// SSRF guard: every outbound peer request goes through here. Reject non-https
// or loopback/link-local/private targets before fetching (covers freshly
// supplied URLs at creation and already-stored URLs).
function assertSafePeerUrl(url: string): void {
  if (!isSafePeerUrl(url)) {
    throw new PeerAuthError(0, 'A peer URL must be https and point at a non-local host');
  }
}

/**
 * Calls the peer's /api/auth/required to see whether auth is enabled.
 * Throws PeerAuthError when the peer cannot be reached.
 */
async function isPeerAuthRequired(url: string): Promise<boolean> {
  assertSafePeerUrl(url);
  const base = normalizePeerUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}/api/auth/required`, {
      method: 'GET',
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PeerAuthError(0, `Cannot reach the peer: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new PeerAuthError(response.status, `Peer check failed: HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => ({}))) as { required?: boolean };
  return body.required === true;
}

/**
 * Logs in to the peer with a password and returns a JWT.
 *
 * When password is undefined or empty:
 *   - peer auth disabled -> returns an empty token (fine)
 *   - peer auth enabled  -> "password required" error
 *
 * When a password is given:
 *   - POSTs to /api/auth/login as usual
 *   - a peer with auth disabled answers 400, which is treated as an empty token
 */
export async function loginToPeer(url: string, password?: string): Promise<string> {
  assertSafePeerUrl(url);
  const base = normalizePeerUrl(url);

  // No password given: check the peer's auth setting first
  if (!password) {
    const required = await isPeerAuthRequired(url);
    if (required) {
      throw new PeerAuthError(401, 'This peer has password auth enabled. Enter its password.');
    }
    return '';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PeerAuthError(0, `Cannot reach the peer: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 400) {
    // Auth is disabled on the peer: it works without a token
    return '';
  }
  if (response.status === 401) {
    throw new PeerAuthError(401, 'Incorrect password');
  }
  if (!response.ok) {
    throw new PeerAuthError(response.status, `Peer login failed: HTTP ${response.status}`);
  }

  const json = (await response.json().catch(() => ({}))) as { token?: string };
  if (!json.token) {
    throw new PeerAuthError(500, 'The peer response carried no token');
  }
  return json.token;
}

/**
 * Probes the peer with /api/auth/me (or /health) to confirm it is reachable.
 * The result is recorded in peer-registry.
 */
export async function verifyPeer(
  peerId: string,
  url: string,
  token: string | undefined,
): Promise<{ ok: true; latencyMs: number } | { ok: false; status: number; message: string }> {
  assertSafePeerUrl(url);
  const base = normalizePeerUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  const start = Date.now();
  let response: Response;
  try {
    // /health answers 200 even on a peer with auth disabled
    response = await fetch(`${base}/health`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordPeerFailure(peerId, `unreachable: ${msg}`);
    return { ok: false, status: 0, message: msg };
  } finally {
    clearTimeout(timer);
  }

  const latency = Date.now() - start;

  if (!response.ok) {
    const msg = `HTTP ${response.status}`;
    await recordPeerFailure(peerId, msg);
    return { ok: false, status: response.status, message: msg };
  }

  await recordPeerSuccess(peerId);
  return { ok: true, latencyMs: latency };
}

/**
 * Calls an arbitrary API path on the peer with authentication.
 * A 401 is recorded as a failure, so the caller can treat the peer as unauthorized.
 */
export async function peerFetch(
  peerId: string,
  url: string,
  token: string | undefined,
  path: string,
  init?: RequestInit,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<Response> {
  assertSafePeerUrl(url);
  const base = normalizePeerUrl(url);

  const headers = new Headers(init?.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordPeerFailure(peerId, `unreachable: ${msg}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    await recordPeerFailure(peerId, 'unauthorized');
  } else if (response.ok) {
    await recordPeerSuccess(peerId);
  }

  return response;
}
