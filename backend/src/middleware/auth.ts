import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import { AuthService, type JwtPayload } from '../services/auth';
import { getDataDir } from '../utils/storage';
import { PASSWORD_ENV } from '../../../shared/identity';

// Extend Hono context with auth info
declare module 'hono' {
  interface ContextVariableMap {
    user: JwtPayload;
  }
}

// The JWT signing secret. Resolved at startup by initJwtSecret(): an explicit
// JWT_SECRET env var wins, otherwise a random 32-byte secret is generated once
// and persisted (0600) in the data dir. There is intentionally NO usable
// default — a hardcoded fallback would let anyone with the source forge tokens
// and bypass password auth entirely.
let jwtSecret: string | null = process.env.JWT_SECRET || null;

// Resolve (and if necessary generate + persist) the JWT signing secret.
// Must be awaited once at server startup before any request is served.
export async function initJwtSecret(): Promise<void> {
  if (jwtSecret) return;
  const dataDir = getDataDir();
  const secretPath = join(dataDir, 'jwt-secret');
  try {
    const existing = (await readFile(secretPath, 'utf-8')).trim();
    if (existing) {
      jwtSecret = existing;
      return;
    }
  } catch {
    // Not yet persisted — fall through to generate.
  }
  const generated = randomBytes(32).toString('hex');
  await mkdir(dataDir, { recursive: true });
  await writeFile(secretPath, generated, { mode: 0o600 });
  await chmod(secretPath, 0o600);
  jwtSecret = generated;
}

// Check if password auth is enabled
export function isAuthRequired(): boolean {
  return !!process.env[PASSWORD_ENV];
}

// Get the server password
export function getServerPassword(): string | undefined {
  return process.env[PASSWORD_ENV];
}

// Middleware that requires auth only if a password is set
export const conditionalAuthMiddleware = createMiddleware(async (c: Context, next: Next) => {
  // If no password is configured, allow all requests
  if (!isAuthRequired()) {
    await next();
    return;
  }

  // Password is set, require authentication
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const token = authHeader.slice(7);
  const authService = new AuthService(getDataDir(), getJwtSecret());

  try {
    const payload = await authService.verifyToken(token);
    c.set('user', payload);
    await next();
  } catch (_error) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// Always require auth (for logout, me endpoints)
export const authMiddleware = createMiddleware(async (c: Context, next: Next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  const authService = new AuthService(getDataDir(), getJwtSecret());

  try {
    const payload = await authService.verifyToken(token);
    c.set('user', payload);
    await next();
  } catch (_error) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

export function getJwtSecret(): string {
  if (!jwtSecret) {
    throw new Error('JWT secret not initialized — call initJwtSecret() at startup');
  }
  return jwtSecret;
}
