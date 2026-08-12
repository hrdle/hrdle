/**
 * hrdle stt-prompt - the words this session's speech is made of.
 *
 *   hrdle stt-prompt "音声認識、Groq、ハルシネーション"   # set
 *   hrdle stt-prompt                                      # show what is set,
 *                                                         # and what is sent
 *   hrdle stt-prompt --clear                              # back to the glossary alone
 *   hrdle stt-prompt --no-glossary                        # this workspace does not
 *                                                         # speak this product's words
 *   hrdle stt-prompt --glossary                           # take it again
 *
 * These lead the vocabulary prompt sent with this session's transcriptions,
 * ahead of the shared glossary - or are the whole of it, with the whole
 * budget, in a workspace that has declined the glossary. A workspace about
 * cooking or bookkeeping never says `リリース`, and paying half the line for
 * words that cannot be spoken there is the reason declining exists. The command exists so the *agent* can set them:
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
  /** Whether this workspace takes the shared glossary. Absent leaves it alone. */
  glossary?: boolean;
  session?: string;
  port: number;
}

/** The cap the route enforces; said here so the CLI can explain it first. */
const MAX_CHARS = 190;

async function putSttPrompt(
  port: number,
  sessionId: string,
  body: { sttPrompt?: string | null; glossary?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `https://localhost:${port}/api/sessions/${encodeURIComponent(sessionId)}/stt-prompt`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

/**
 * What a transcription from this session would carry, as the server resolves it.
 *
 * The same object `/stt-preview` serves the settings screen, printed here
 * because a session's words are usually being read in a terminal by whoever is
 * about to change them, and "did that reach the prompt" is the next question
 *. Best-effort: a server that will not answer costs a line on stderr,
 * not an exit code - the words above were still shown.
 */
async function printSttRequest(port: number, sessionId: string): Promise<void> {
  interface Preview {
    model: string;
    modelSource: string;
    language: string | null;
    languageSource: string;
    prompt: string | null;
    promptSource: 'composed' | 'env' | 'off';
    promptComposition: {
      groups: Array<{ name: string; taken: string[] }>;
      usedChars: number;
      maxChars: number;
      glossaryEnabled: boolean;
    } | null;
  }

  let preview: Preview;
  try {
    const res = await fetch(
      `https://localhost:${port}/api/glasses/stt-preview?session=${encodeURIComponent(sessionId)}`,
    );
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    preview = (await res.json()) as Preview;
  } catch (err) {
    console.error(`(cannot show what is sent: ${err instanceof Error ? err.message : 'failed'})`);
    return;
  }

  const promptLine =
    preview.promptSource === 'off'
      ? '(none - the vocabulary bias is switched off)'
      : preview.prompt || '(none)';

  console.log('');
  console.log('Sent with this session\'s speech:');
  console.log(`  model     ${preview.model} (${preview.modelSource})`);
  console.log(`  language  ${preview.language ?? 'auto (detected by Whisper)'} (${preview.languageSource})`);
  console.log(`  prompt    ${promptLine}`);
  if (preview.promptSource === 'env') {
    console.log('            replaced wholesale by the environment');
  }
  const composition = preview.promptComposition;
  if (composition) {
    const groups = composition.groups
      .map((group) => `${group.name} ${group.taken.length}`)
      .join(', ');
    console.log(`            ${composition.usedChars}/${composition.maxChars} chars - ${groups}`);
    if (!composition.glossaryEnabled) {
      console.log('            glossary declined - the whole line is this workspace\'s');
    }
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

  // Show: what this session has now, read from the list already fetched, and
  // then what is actually sent with it - which is the question these words are
  // usually being read to answer.
  if (options.glossary !== undefined) {
    const result = await putSttPrompt(port, sessionId, { glossary: options.glossary });
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(
      options.glossary
        ? `${sessionId} takes the shared glossary`
        : `${sessionId} declines the shared glossary - its own words get the whole budget`,
    );
    if (options.text === undefined) {
      await printSttRequest(port, sessionId);
      return;
    }
  }

  if (options.text === undefined) {
    // `(none)` only when the list was read and this session is not in it. With
    // no list - an explicit --session against a server that could not tell us
    // who we are - saying "none" would be inventing an answer, which is the
    // shape of mistake this command is being fixed for.
    console.log(
      'sessions' in resolved
        ? resolved.sessions.find((s) => s.id === sessionId)?.sttPrompt || '(none)'
        : '(not read - the server did not list this session)',
    );
    await printSttRequest(port, sessionId);
    return;
  }

  const text = options.text === null ? null : options.text.trim();
  if (text !== null && text.length > MAX_CHARS) {
    console.error(
      `Too long (${text.length} chars, max ${MAX_CHARS}). Name what this session is about, not everything it might say - and note that with the glossary on, only the first ${MAX_CHARS / 2} characters can be taken.`,
    );
    process.exit(1);
  }

  const result = await putSttPrompt(port, sessionId, { sttPrompt: text || null });
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(text ? `stt-prompt for ${sessionId}: ${text}` : `stt-prompt for ${sessionId} cleared`);
}
