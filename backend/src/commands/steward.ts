/**
 * `hrdle steward <verb>` - how the steward reaches its owner.
 *
 * A CLI rather than an MCP server, for the same reason `hrdle glasses` is one:
 * the steward is a Claude Code session, and a command it can type is a tool it
 * already knows how to use. It also keeps one set of tools - touching herdr
 * goes through an allowlist wrapper, so delivering through a command means the
 * steward only ever runs commands.
 *
 * These verbs only reach a person. Session control must not be added here.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthService } from '../services/auth';
import { getDataDir } from '../utils/storage';
import { stewardHomeDir, TARGET_FILE } from '../services/steward-runtime';
import { IDENTITY } from '../../../shared/identity';

const TOKEN_USER = 'steward';

export interface StewardCliOptions {
  portExplicit?: boolean;
  stewardVerb?: 'notify' | 'ask' | 'report' | 'line' | 'turns' | 'screen' | 'thread';
  /** Positional words after the verb, in order. */
  stewardArgs?: string[];
  stewardDetail?: string;
  stewardChoices?: string[];
  stewardMode?: 'single' | 'multi' | 'freeText';
  stewardStep?: { index: number; total: number };
  stewardFile?: string;
  port: number;
}

/**
 * Sign a token from the secret the server persists - same user, so no second
 * credential has to be invented.
 *
 * Null when there is nothing to read: normal without a password, and a trap on
 * an install keeping its secret in `JWT_SECRET`, where the file is never
 * written and a command does not inherit the server's environment. Said out
 * loud at the 401 rather than left unexplained.
 */
async function resolveToken(): Promise<string | null> {
  let secret = process.env.JWT_SECRET ?? null;
  if (!secret) {
    try {
      secret = (await readFile(join(getDataDir(), 'jwt-secret'), 'utf-8')).trim() || null;
    } catch {
      secret = null;
    }
  }
  if (!secret) return null;
  return new AuthService(getDataDir(), secret).generateTokenForUser(TOKEN_USER);
}

/**
 * Which server to deliver to.
 *
 * The steward never passes `-p`: it is told where to write by the server that
 * started it. Without this the observer's every message went to the default
 * port, where the steward is not enabled, and came back "not enabled on this
 * server" - found by watching it try.
 */
async function resolvePort(options: StewardCliOptions & { port: number }): Promise<number> {
  if (options.portExplicit) return options.port;
  try {
    const raw = await readFile(join(stewardHomeDir(), TARGET_FILE), 'utf-8');
    const target = JSON.parse(raw) as { port?: number };
    if (typeof target.port === 'number') return target.port;
  } catch {
    // No target file: not running inside the steward, so the default is right.
  }
  return options.port;
}

/**
 * Null when the server does not answer at all - too old, or not there.
 *
 * Carries the token: `/enabled` is inside the authenticated glob, so a bare
 * probe against a password-protected install gets 401 and reads as "no server",
 * which is exactly the misdiagnosis the probe exists to prevent - on the
 * configuration where it matters most.
 */
async function stewardIsEnabled(port: number, token: string | null): Promise<boolean | null> {
  try {
    const res = await fetch(`https://localhost:${port}/api/steward/enabled`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return ((await res.json()) as { enabled?: boolean }).enabled === true;
  } catch {
    return null;
  }
}

async function api(port: number, method: string, path: string, body?: unknown): Promise<unknown> {
  // HTTPS even on loopback: the server serves nothing in the clear, and its
  // Tailscale cert does not match `localhost` - same TLS skip as notify.ts.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const token = await resolveToken();

  const res = await fetch(`https://localhost:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();

  if (res.status === 404) {
    // Ask which kind of 404 this is. `/enabled` answers whether or not the
    // steward is on, so a server that has never heard of it fails here too -
    // and "not enabled" would be exactly the wrong thing to tell someone whose
    // server is simply too old.
    const enabled = await stewardIsEnabled(port, token);
    if (enabled === null) {
      throw new Error(`no ${IDENTITY.productName} answering on port ${port}, or one too old to have the steward`);
    }
    throw new Error(
      enabled
        ? `${method} ${path} -> 404 (the steward is enabled; this route is not there)`
        : 'the steward is not enabled on this server',
    );
  }
  if (res.status === 401) {
    // Both directions of the same trap: a server keeping its secret in
    // JWT_SECRET never writes the file, and a file left over from an earlier
    // run signs a token that server will reject.
    throw new Error(
      token
        ? `signed a token the server rejected. ${join(getDataDir(), 'jwt-secret')} may be stale - ` +
          'a server running JWT_SECRET from its environment does not use that file. Export the same value here.'
        : 'this server requires authentication but no signing secret was readable. An install ' +
          `keeping JWT_SECRET in the environment never writes ${join(getDataDir(), 'jwt-secret')}; ` +
          'export the same JWT_SECRET here.',
    );
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/** JSON on stdout, so the steward can read back what it just wrote. */
function emit(value: unknown): void {
  console.log(JSON.stringify(value));
}

async function readPayload(options: StewardCliOptions): Promise<unknown> {
  const raw = options.stewardFile
    ? await readFile(options.stewardFile, 'utf-8')
    : await Bun.stdin.text();
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`payload is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

export async function runSteward(options: StewardCliOptions): Promise<void> {
  const args = options.stewardArgs ?? [];
  try {
    const port = await resolvePort(options);
    switch (options.stewardVerb) {
      case 'notify': {
        const text = args[0];
        if (!text) throw new Error('usage: hrdle steward notify <text> [--detail <markdown>]');
        emit(
          await api(port, 'POST', '/api/steward/thread', {
            kind: 'notify',
            text,
            detail: options.stewardDetail,
          }),
        );
        return;
      }

      case 'ask': {
        const text = args[0];
        if (!text) {
          throw new Error(
            'usage: hrdle steward ask <text> [--choices "a,b"] [--mode single|multi|freeText] [--step 2/3]',
          );
        }
        emit(
          await api(port, 'POST', '/api/steward/thread', {
            kind: 'ask',
            text,
            choices: options.stewardChoices ?? [],
            mode: options.stewardMode ?? 'single',
            step: options.stewardStep,
            detail: options.stewardDetail,
          }),
        );
        return;
      }

      case 'report': {
        const text = args[0];
        if (!text) throw new Error('usage: hrdle steward report <heading> --file <rows>, or rows on stdin');
        // Rows are one per line rather than a flag: a report is a list, and a
        // comma-separated flag cannot hold a line with a comma in it.
        const raw = options.stewardFile
          ? await readFile(options.stewardFile, 'utf-8')
          : await Bun.stdin.text();
        const rows = raw.split('\n').map((r) => r.trimEnd()).filter(Boolean);
        emit(
          await api(port, 'POST', '/api/steward/thread', {
            kind: 'report',
            text,
            rows,
            detail: options.stewardDetail,
          }),
        );
        return;
      }

      case 'line': {
        const [session, text] = args;
        if (!session || text === undefined) throw new Error('usage: hrdle steward line <session> <text>');
        emit(await api(port, 'PUT', `/api/steward/sessions/${encodeURIComponent(session)}/line`, { text }));
        return;
      }

      case 'turns': {
        const session = args[0];
        if (!session) throw new Error('usage: hrdle steward turns <session> --file <json>, or JSON on stdin');
        const payload = await readPayload(options);
        // Both shapes accepted: the array is what a caller naturally writes,
        // and the object is what the endpoint takes.
        const turns = Array.isArray(payload) ? payload : (payload as { turns?: unknown }).turns;
        emit(await api(port, 'POST', `/api/steward/sessions/${encodeURIComponent(session)}/turns`, { turns }));
        return;
      }

      case 'screen':
        emit(await api(port, 'GET', '/api/steward/screen'));
        return;

      // Its own conversation, which it cannot otherwise see: a wake-up carries
      // the answer that triggered it, so anything said while the observer was
      // down or mid-turn is only here.
      case 'thread': {
        const snapshot = (await api(port, 'GET', '/api/steward')) as { thread?: unknown[] };
        const limit = Number(args[0]) || 20;
        emit({ thread: (snapshot.thread ?? []).slice(-limit) });
        return;
      }

      default:
        console.error('usage: hrdle steward <notify|ask|report|line|turns|screen|thread> ...');
        process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
