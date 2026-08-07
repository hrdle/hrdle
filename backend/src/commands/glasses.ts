/**
 * hrdle glasses - POSTs a note written by the agent itself to the G2 glasses
 * relay channel (#504).
 *
 *   hrdle glasses "Tests are green. Ship it?" --kind waiting --choices "ship,hold"
 *   hrdle glasses "Build finished" --kind info
 *
 * Session resolution is `session-target.ts` (cwd, then /proc ancestry, then
 * --session). Delivery follows notify: both the production and dev ports,
 * failures stay silent (-p targets a single one).
 */

import { IDENTITY } from '../../../shared/identity';
import { type ResolvedTarget, resolveOwnSession } from './session-target';

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

  let target: ResolvedTarget;
  if (options.session) {
    target = { sessionId: options.session };
  } else {
    const resolved = await resolveOwnSession(ports);
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
