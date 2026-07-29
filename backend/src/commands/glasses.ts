/**
 * hrdle glasses - POSTs a note written by the agent itself to the G2 glasses
 * relay channel (#504).
 *
 *   hrdle glasses "Tests are green. Ship it?" --kind waiting --choices "ship,hold"
 *   hrdle glasses "Build finished" --kind info
 *
 * Session resolution: a unique cwd match first; when that is ambiguous, the
 * /proc ppid ancestry is matched against each pane's foreground pid (this is
 * what makes worktrees work); failing both, --session becomes mandatory.
 * Delivery follows notify: both the production and dev ports, failures stay
 * silent (-p targets a single one).
 */

import { readFileSync } from 'node:fs';
import { IDENTITY } from '../../../shared/identity';

// Derived from identity, same as notify.ts (#459). Hardcoding these would keep
// posting to the old product's port after a rename, where the receiving side
// only sees a session it cannot resolve.
const PRODUCTION_PORT = IDENTITY.defaultPort;
const DEV_PORT = IDENTITY.devPort;

export interface GlassesCliOptions {
  text?: string;
  kind: 'waiting' | 'info';
  choices?: string[];
  session?: string;
  port: number;
}

interface SessionPane {
  paneId: string;
  isActive?: boolean;
  pid?: number;
}

interface SessionEntry {
  id: string;
  currentPath?: string;
  panes?: SessionPane[];
}

interface ResolvedTarget {
  sessionId: string;
  paneId?: string;
}

async function fetchSessions(port: number): Promise<SessionEntry[] | null> {
  try {
    const res = await fetch(`https://localhost:${port}/api/sessions`);
    if (!res.ok) return null; // e.g. 401 when the server has a password set
    const json = (await res.json()) as { sessions?: SessionEntry[] };
    return json.sessions ?? null;
  } catch {
    return null;
  }
}

/**
 * Walk /proc up from our parent, collecting ancestor pids. The CLI runs as a
 * grandchild of the pane's foreground agent (agent → bash → cchub), so the
 * agent's pid — reported as PaneInfo.pid — always appears in this set.
 */
export function ancestorPids(fromPid: number = process.ppid): Set<number> {
  const seen = new Set<number>();
  let pid = fromPid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    if (seen.has(pid)) break;
    seen.add(pid);
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    } catch {
      break;
    }
    // "pid (comm) state ppid …" — comm may contain spaces/parens, so parse
    // after the last ')'. Fields after it: state ppid pgrp …
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number.parseInt(rest[1], 10);
    if (!Number.isFinite(ppid)) break;
    pid = ppid;
  }
  return seen;
}

function pickActivePane(session: SessionEntry): SessionPane | undefined {
  return session.panes?.find((p) => p.isActive) ?? session.panes?.[0];
}

/** Pure resolution against a fetched session list (exported for tests). */
export function resolveSessionTarget(
  sessions: SessionEntry[],
  cwd: string,
  ancestors: Set<number>,
): { target: ResolvedTarget } | { error: string } {
  // 1. cwd exact match
  const exact = sessions.filter((s) => s.currentPath && cwd === s.currentPath);
  if (exact.length === 1) {
    return { target: { sessionId: exact[0].id, paneId: pickActivePane(exact[0])?.paneId } };
  }

  // 2. cwd prefix match (the Bash tool cd'ed into a subdirectory)
  if (exact.length === 0) {
    const prefix = sessions.filter(
      (s) => s.currentPath && cwd.startsWith(`${s.currentPath}/`),
    );
    if (prefix.length === 1) {
      return { target: { sessionId: prefix[0].id, paneId: pickActivePane(prefix[0])?.paneId } };
    }
    if (prefix.length > 1) {
      // Deepest directory wins (a nested project is more specific than its parent).
      prefix.sort((a, b) => (b.currentPath?.length ?? 0) - (a.currentPath?.length ?? 0));
      if (prefix[0].currentPath !== prefix[1].currentPath) {
        return { target: { sessionId: prefix[0].id, paneId: pickActivePane(prefix[0])?.paneId } };
      }
    }
  }

  // 3. /proc ancestor ↔ pane foreground pid (worktree: several sessions share
  //    one cwd, but only one of their agents is our ancestor)
  const byPid = sessions
    .map((s) => ({ s, pane: s.panes?.find((p) => p.pid !== undefined && ancestors.has(p.pid)) }))
    .filter((m): m is { s: SessionEntry; pane: SessionPane } => !!m.pane);
  if (byPid.length === 1) {
    return { target: { sessionId: byPid[0].s.id, paneId: byPid[0].pane.paneId } };
  }

  return {
    error:
      'Cannot identify the session (more than one session on the same cwd?). Pass `hrdle glasses ... --session <id>`',
  };
}

async function postRelay(port: number, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://localhost:${port}/api/glasses/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

export async function runGlasses(options: GlassesCliOptions): Promise<void> {
  const text = options.text?.trim();
  if (!text) {
    console.error('Usage: hrdle glasses <text> [--kind waiting|info] [--choices "a,b"] [--session <id>]');
    process.exit(1);
  }

  // hrdle serves HTTPS on localhost (Tailscale cert for the hostname, not
  // localhost) — same TLS-skip pattern as notify.ts.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const ports =
    options.port !== PRODUCTION_PORT ? [options.port] : [PRODUCTION_PORT, DEV_PORT];

  let target: ResolvedTarget | undefined;
  if (options.session) {
    target = { sessionId: options.session };
  } else {
    // Resolve against the first reachable server; prod and dev share the same
    // herdr, so the workspace set is identical either way.
    let sessions: SessionEntry[] | null = null;
    for (const port of ports) {
      sessions = await fetchSessions(port);
      if (sessions) break;
    }
    if (!sessions) {
      console.error('Cannot fetch the session list (server not running, or auth is enabled). Pass --session <id>');
      process.exit(1);
    }
    const resolved = resolveSessionTarget(sessions, process.cwd(), ancestorPids());
    if ('error' in resolved) {
      console.error(resolved.error);
      process.exit(1);
    }
    target = resolved.target;
  }

  const body: Record<string, unknown> = {
    sessionId: target.sessionId,
    kind: options.kind,
    text,
  };
  if (target.paneId) body.paneId = target.paneId;
  if (options.choices && options.choices.length > 0) body.choices = options.choices;

  // Silent failure, same as cchub notify: the CLI is called from agent Bash
  // turns and must never block them. A 409 (active waiting already exists) is
  // also silent — the unanswered decision stays on the glasses, which is the
  // correct outcome.
  await Promise.allSettled(ports.map((p) => postRelay(p, body)));
}
