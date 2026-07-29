/**
 * hrdle send - send raw input to a specific pane on a peer or local hrdle server.
 *
 * Usage:
 *   hrdle send <peer>:<session>:<paneId> "text"
 *   echo "text" | hrdle send <peer>:<session>:<paneId> --stdin
 *   hrdle send <peer>:<session>:<paneId> "ls -la" --newline
 *
 * <peer> can be a peer nickname, peer id, or "local" for self.
 */

import { listPeers, type StoredPeer } from '../services/peer-registry';

export interface SendOptions {
  target: string;
  text?: string;
  stdin: boolean;
  newline: boolean;
  // Wrap payload in bracketed paste markers + a single CR, so the TUI submits
  // the input deterministically regardless of payload size. See `runSend` for
  // the rationale and `\r\r` fallback's failure mode.
  submit: boolean;
  base64: boolean;
  localPort: number;
  // --wait: after sending, snapshot the pane viewport and print it. Useful so
  // the sender can see what landed on the peer's screen (and whether the peer
  // is mid-permission-prompt) without opening the peer UI.
  wait: boolean;
  waitMs: number;   // delay before snapshot
  lines: number;    // trailing rows to print (0 = whole viewport)
}

interface ViewportResponse {
  cols: number;
  rows: number;
  totalLines: number;
  lines: string[];      // ANSI preserved
  text: string;          // ANSI stripped
  cursor: { x: number; y: number; visible: boolean };
  detectedState: 'permission_prompt' | 'ask_user_question' | 'processing' | 'idle' | 'unknown';
}

function printViewport(target: ParsedTarget, vp: ViewportResponse): void {
  const stateLabel: Record<ViewportResponse['detectedState'], string> = {
    permission_prompt: 'permission_prompt (peer is waiting for Yes/No)',
    ask_user_question: 'ask_user_question (peer is waiting for a numbered choice)',
    processing: '⏳ processing (peer is running a tool)',
    idle: 'idle (peer is at the prompt)',
    unknown: '?  unknown',
  };
  console.error(`\n── ${target.peer}:${target.sessionId}:${target.paneId} (${vp.cols}x${vp.rows}) — ${stateLabel[vp.detectedState]}`);
  // Print viewport WITH ANSI escapes preserved so colors come through.
  for (const line of vp.lines) {
    console.log(line);
  }
  console.error(`── end ─ cursor (${vp.cursor.x},${vp.cursor.y})`);
}

interface ParsedTarget {
  peer: string;
  sessionId: string;
  paneId: string;
}

function parseTarget(target: string): ParsedTarget {
  const parts = target.split(':');
  if (parts.length !== 3 || parts.some(p => !p)) {
    throw new Error(`target must look like <peer>:<session>:<paneId> (got: ${target})`);
  }
  return { peer: parts[0], sessionId: parts[1], paneId: parts[2] };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function resolvePeer(name: string, localPort: number): Promise<{ url: string; token?: string }> {
  if (name === 'local' || name === 'self') {
    // cchub serves HTTPS on localhost (Tailscale cert). notify.ts uses the same pattern.
    return { url: `https://localhost:${localPort}` };
  }
  const peers = await listPeers();
  const match = peers.find(
    (p): p is StoredPeer => p.id === name || p.nickname === name,
  );
  if (!match) {
    const known = peers.map(p => `${p.id} (${p.nickname})`).join(', ');
    throw new Error(`peer "${name}" not found. Registered peers: ${known || '(none)'}`);
  }
  if (match.url === 'self') {
    return { url: `http://localhost:${localPort}`, token: undefined };
  }
  return { url: match.url.replace(/\/+$/, ''), token: match.wsToken };
}

export async function runSend(options: SendOptions): Promise<void> {
  const target = parseTarget(options.target);

  // --submit / --newline wrap the payload in VT escapes (bracketed-paste
  // markers, trailing CR). With --base64 the payload is meant to be a literal
  // base64 string the server decodes verbatim, so wrapping it would inject
  // non-base64 bytes and break decoding. Reject the combination up front
  // rather than send a corrupt payload (#351).
  if (options.base64 && (options.submit || options.newline)) {
    throw new Error('--base64 cannot be combined with --submit / --newline');
  }

  let payload: string;
  if (options.stdin) {
    payload = await readStdin();
  } else if (options.text !== undefined) {
    payload = options.text;
  } else {
    throw new Error('Pass either a text argument or --stdin');
  }

  if (options.newline) {
    payload = `${payload}\r`;
  }
  if (options.submit) {
    // Bracketed paste-and-submit protocol: wrap the body in DECSET 2004
    // markers and follow with a single CR. The TUI treats everything
    // between \x1b[200~ and \x1b[201~ as a literal paste (so any CR
    // inside becomes a newline in the input box), then the CR AFTER the
    // closing marker is interpreted as a real Enter keypress, which
    // submits the input.
    //
    // The previous naive `\r\r` strategy works for short payloads but
    // breaks once the payload reaches ~300 bytes: when the TUI reads a
    // large batch of bytes in one go, its auto-paste-detection treats
    // the entire batch as a paste and absorbs our trailing CRs as
    // literal newlines in the input box — leaving the text sitting
    // unsubmitted. Explicit paste markers make the boundary unambiguous
    // and fix the long-payload submit bug.
    //
    // Assumes the receiving TUI supports bracketed paste (\x1b[?2004h);
    // Claude Code TUI and Codex TUI both do. Use --newline for plain
    // shells that don't.
    payload = `\x1b[200~${payload}\x1b[201~\r`;
  }

  const peer = await resolvePeer(target.peer, options.localPort);

  // With --base64 the payload is already a base64 string; utf-8 goes through as is
  const body: Record<string, unknown> = {
    paneId: target.paneId,
    data: payload,
    encoding: options.base64 ? 'base64' : 'utf-8',
  };
  if (options.wait) {
    body.wait = true;
    body.waitMs = options.waitMs;
    body.lines = options.lines;
  }

  // The Tailscale certificate does not match the localhost name, so TLS verification is off (same as notify.ts)
  if (peer.url.startsWith('https://')) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (peer.token) {
    headers.Authorization = `Bearer ${peer.token}`;
  }

  const url = `${peer.url}/api/sessions/${encodeURIComponent(target.sessionId)}/panes/input`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`send failed: HTTP ${res.status} ${errText}`);
  }

  const json = (await res.json().catch(() => ({}))) as { bytes?: number; viewport?: ViewportResponse };
  console.error(`sent ${json.bytes ?? payload.length} bytes to ${target.peer}:${target.sessionId}:${target.paneId}`);
  if (json.viewport) {
    printViewport(target, json.viewport);
  }
}

export interface PeekOptions {
  target: string;
  lines: number;
  localPort: number;
}

export async function runPeek(options: PeekOptions): Promise<void> {
  const target = parseTarget(options.target);
  const peer = await resolvePeer(target.peer, options.localPort);

  if (peer.url.startsWith('https://')) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const headers: Record<string, string> = {};
  if (peer.token) {
    headers.Authorization = `Bearer ${peer.token}`;
  }

  const url = `${peer.url}/api/sessions/${encodeURIComponent(target.sessionId)}/panes/${encodeURIComponent(target.paneId)}/viewport?lines=${options.lines}`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`peek failed: HTTP ${res.status} ${errText}`);
  }

  const vp = (await res.json()) as ViewportResponse;
  printViewport(target, vp);
}
