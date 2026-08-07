/**
 * hrdle stt-prompt - the words this session's speech is made of (#210).
 *
 *   hrdle stt-prompt "音声認識、Groq、ハルシネーション"   # set
 *   hrdle stt-prompt                                      # show what is set
 *   hrdle stt-prompt --clear                              # back to the glossary alone
 *
 * These lead the vocabulary prompt sent with this session's transcriptions,
 * ahead of the shared glossary. The command exists so the *agent* can set them:
 * workspace labels used to supply this half of the vocabulary and were a poor
 * source (see `services/stt-prompt.ts`), while the agent in a session knows
 * what is about to be said next, which no label does.
 *
 * Unlike `hrdle glasses`, failures are reported rather than swallowed - this is
 * run to change something, and silently not changing it is worse than a line of
 * output.
 */

import { IDENTITY } from '../../../shared/identity';
import { resolveOwnSession } from './session-target';

const PRODUCTION_PORT = IDENTITY.defaultPort;
const DEV_PORT = IDENTITY.devPort;

export interface SttPromptCliOptions {
  /** Words to set. Absent means "show"; `null` means "clear". */
  text?: string | null;
  session?: string;
  port: number;
}

/** The cap the route enforces; said here so the CLI can explain it first. */
const MAX_CHARS = 100;

async function putSttPrompt(
  port: number,
  sessionId: string,
  sttPrompt: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `https://localhost:${port}/api/sessions/${encodeURIComponent(sessionId)}/stt-prompt`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sttPrompt }),
      },
    );
    if (res.ok) return { ok: true };
    if (res.status === 404) return { ok: false, error: `No session ${sessionId}` };
    if (res.status === 401) return { ok: false, error: 'Not authorized (the server has a password set)' };
    return { ok: false, error: `Server returned ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'request failed' };
  }
}

export async function runSttPrompt(options: SttPromptCliOptions): Promise<void> {
  // hrdle serves HTTPS on localhost (Tailscale cert for the hostname, not
  // localhost) - same TLS-skip pattern as notify.ts.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const ports = options.port !== PRODUCTION_PORT ? [options.port] : [PRODUCTION_PORT, DEV_PORT];

  const resolved = await resolveOwnSession(ports);
  // An explicit --session does not need us to have worked out who we are, but
  // it still needs a server: the prompt is stored there, not here.
  if ('error' in resolved && !options.session) {
    console.error(resolved.error);
    process.exit(1);
  }
  const sessionId =
    options.session ?? ('target' in resolved ? resolved.target.sessionId : undefined);
  if (!sessionId) {
    console.error('Cannot identify the session. Pass `--session <id>`');
    process.exit(1);
  }
  const port = 'port' in resolved ? resolved.port : ports[0];

  // Show: what this session has now, read from the list already fetched.
  if (options.text === undefined) {
    const current =
      'sessions' in resolved
        ? resolved.sessions.find((s) => s.id === sessionId)?.sttPrompt
        : undefined;
    console.log(current || '(none)');
    return;
  }

  const text = options.text === null ? null : options.text.trim();
  if (text !== null && text.length > MAX_CHARS) {
    console.error(
      `Too long (${text.length} chars, max ${MAX_CHARS}). These words lead the prompt, and it is capped - a long list only pushes out the glossary behind it. Name what this session is about, not everything it might say.`,
    );
    process.exit(1);
  }

  const result = await putSttPrompt(port, sessionId, text || null);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(text ? `stt-prompt for ${sessionId}: ${text}` : `stt-prompt for ${sessionId} cleared`);
}
