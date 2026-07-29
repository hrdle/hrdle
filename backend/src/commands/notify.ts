/**
 * hrdle notify - forwards Claude Code / Codex hook events to the hrdle server.
 * Reads the hook's JSON from stdin and POSTs it to hrdle's /api/notify endpoint.
 * By default it posts to both the production and dev ports (both derived from
 * identity); failures are ignored.
 *
 * Usage (hook configuration):
 *   "command": "hrdle notify"
 */

import { IDENTITY } from '../../../shared/identity';

const PRODUCTION_PORT = IDENTITY.defaultPort;
const DEV_PORT = IDENTITY.devPort;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function postToPort(port: number, body: string, useHttps: boolean): Promise<void> {
  const protocol = useHttps ? 'https' : 'http';
  const url = `${protocol}://localhost:${port}/api/notify`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
}

export async function sendNotify(port: number): Promise<void> {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      return;
    }

    // Validate JSON
    const json = JSON.parse(input);
    const body = JSON.stringify(json);

    // Skip TLS verification since cert is for Tailscale hostname, not localhost
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    // Determine target ports. The server always serves over HTTPS (Tailscale
    // cert), including in dev, so every target uses https. TLS verification is
    // disabled above because the cert is for the Tailscale hostname, not
    // localhost.
    const ports = port !== PRODUCTION_PORT
      // Explicit port specified via -p: send to that port only.
      ? [{ port, https: true }]
      // Default: try both production and dev, ignore failures.
      : [
          { port: PRODUCTION_PORT, https: true },
          { port: DEV_PORT, https: true },
        ];

    await Promise.allSettled(
      ports.map(({ port: p, https }) => postToPort(p, body, https))
    );
  } catch {
    // Silent failure - hook should not block Claude Code
  }
}
