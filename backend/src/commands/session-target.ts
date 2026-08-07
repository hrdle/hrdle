/**
 * "Which session am I?" - session resolution for CLI commands an agent runs
 * from inside its own pane (`hrdle glasses`, `hrdle stt-prompt`).
 *
 * A unique cwd match first; when that is ambiguous, the /proc ppid ancestry is
 * matched against each pane's foreground pid (this is what makes worktrees
 * work); failing both, the caller has to pass `--session`.
 */

import { readFileSync } from 'node:fs';

export interface SessionPane {
  paneId: string;
  isActive?: boolean;
  pid?: number;
}

export interface SessionEntry {
  id: string;
  title?: string;
  currentPath?: string;
  sttPrompt?: string;
  panes?: SessionPane[];
}

export interface ResolvedTarget {
  sessionId: string;
  paneId?: string;
}

/** Sessions from the first server that answers, or null if none does. */
export async function fetchSessions(port: number): Promise<SessionEntry[] | null> {
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
 * grandchild of the pane's foreground agent (agent → bash → hrdle), so the
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
    const prefix = sessions.filter((s) => s.currentPath && cwd.startsWith(`${s.currentPath}/`));
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
      'Cannot identify the session (more than one session on the same cwd?). Pass `--session <id>`',
  };
}

/**
 * Which session we are running in, resolved against the first server that
 * answers. Production and dev share one herdr, so the workspace set is the same
 * either way. The session list comes back with the target because a caller that
 * wants to *read* the session's own settings already has them here.
 */
export async function resolveOwnSession(
  ports: number[],
): Promise<{ target: ResolvedTarget; sessions: SessionEntry[]; port: number } | { error: string }> {
  let sessions: SessionEntry[] | null = null;
  let port: number | undefined;
  for (const candidate of ports) {
    sessions = await fetchSessions(candidate);
    if (sessions) {
      port = candidate;
      break;
    }
  }
  if (!sessions || port === undefined) {
    return {
      error:
        'Cannot fetch the session list (server not running, or auth is enabled). Pass `--session <id>`',
    };
  }
  const resolved = resolveSessionTarget(sessions, process.cwd(), ancestorPids());
  if ('error' in resolved) return resolved;
  return { target: resolved.target, sessions, port };
}
