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

const TOKEN_USER = 'steward';

export interface StewardCliOptions {
  stewardVerb?: 'notify' | 'ask' | 'report' | 'line' | 'turns' | 'screen';
  /** Positional words after the verb, in order. */
  stewardArgs?: string[];
  stewardDetail?: string;
  stewardChoices?: string[];
  stewardMode?: 'single' | 'multi' | 'freeText';
  stewardStep?: { index: number; total: number };
  stewardFile?: string;
  stewardStdin?: boolean;
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
    throw new Error('the steward is not enabled on this server');
  }
  if (res.status === 401 && !token) {
    throw new Error(
      'this server requires authentication but no signing secret was readable. An install ' +
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
    switch (options.stewardVerb) {
      case 'notify': {
        const text = args[0];
        if (!text) throw new Error('usage: hrdle steward notify <text> [--detail <markdown>]');
        emit(
          await api(options.port, 'POST', '/api/steward/thread', {
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
          await api(options.port, 'POST', '/api/steward/thread', {
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
        if (!text) throw new Error('usage: hrdle steward report <heading> --rows-stdin | --file <json>');
        // Rows are one per line rather than a flag: a report is a list, and a
        // comma-separated flag cannot hold a line with a comma in it.
        const raw = options.stewardFile
          ? await readFile(options.stewardFile, 'utf-8')
          : await Bun.stdin.text();
        const rows = raw.split('\n').map((r) => r.trimEnd()).filter(Boolean);
        emit(
          await api(options.port, 'POST', '/api/steward/thread', {
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
        emit(await api(options.port, 'PUT', `/api/steward/sessions/${encodeURIComponent(session)}/line`, { text }));
        return;
      }

      case 'turns': {
        const session = args[0];
        if (!session) throw new Error('usage: hrdle steward turns <session> --file <json> | --stdin');
        const payload = await readPayload(options);
        // Both shapes accepted: the array is what a caller naturally writes,
        // and the object is what the endpoint takes.
        const turns = Array.isArray(payload) ? payload : (payload as { turns?: unknown }).turns;
        emit(await api(options.port, 'POST', `/api/steward/sessions/${encodeURIComponent(session)}/turns`, { turns }));
        return;
      }

      case 'screen':
        emit(await api(options.port, 'GET', '/api/steward/screen'));
        return;

      default:
        console.error('usage: hrdle steward <notify|ask|report|line|turns|screen> ...');
        process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
