import type { SessionsResponse, DashboardResponse, ConversationResponse, ConversationMessage } from './types.ts'

let baseUrl = ''

export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, '')
}

export function getBaseUrl(): string {
  return baseUrl
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json() as Promise<T>
}

export function getSessions(): Promise<SessionsResponse> {
  return fetchJson('/api/sessions')
}

export function getDashboard(): Promise<DashboardResponse> {
  return fetchJson('/api/dashboard')
}

export async function getConversation(ccSessionId: string, last = 10): Promise<ConversationMessage[]> {
  try {
    const data = await fetchJson<ConversationResponse>(
      `/api/sessions/history/${ccSessionId}/conversation?last=${last}`
    )
    return data.messages
  } catch {
    return []
  }
}

/** Send raw 16-bit mono PCM to the server for Groq transcription. Returns the recognized text. */
export async function transcribe(pcm: Uint8Array, sampleRate = 16000): Promise<string> {
  // Copy into a tightly-sized ArrayBuffer so the fetch body types cleanly.
  const body = new Uint8Array(pcm.length)
  body.set(pcm)
  const res = await fetch(`${baseUrl}/api/glasses/stt?sampleRate=${sampleRate}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: body.buffer,
  })
  if (!res.ok) throw new Error(`STT ${res.status}`)
  const data = (await res.json()) as { text?: string }
  return (data.text || '').trim()
}

/** Send a free-text prompt to a session (bracketed paste + Enter server-side = submit).
 *  `paneId` targets a specific pane (glasses relay reply routing #504): in a
 *  multi-pane workspace the blocked pane is not necessarily the active one. */
export async function sendPrompt(sessionId: string, text: string, paneId?: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(paneId ? { text, paneId } : { text }),
  })
  if (!res.ok) throw new Error(`prompt ${res.status}`)
}

/** Send raw input bytes (arrow keys / Enter) to a specific pane. Unlike the WS
 *  `input` frame this needs no subscription — used for relay-item choice keys
 *  where the item carries the exact blocked paneId (#504). */
export async function sendPaneInput(sessionId: string, paneId: string, data: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/panes/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paneId, data }),
  })
  if (!res.ok) throw new Error(`pane input ${res.status}`)
}

/** Ship a diagnostic line to the hub's browser log (`/api/logs`, no auth).
 *
 *  The glasses run inside a WebView whose console nobody can reach, so an
 *  uncaught exception kills the app with no trace at all. This is the only way
 *  to see why. Best effort: never throws, never blocks the caller. */
export async function reportLog(level: string, message: string, stack?: string): Promise<void> {
  if (!baseUrl) return
  try {
    await fetch(`${baseUrl}/api/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level,
        message: `[glasses] ${message}`,
        timestamp: new Date().toISOString(),
        stack,
      }),
    })
  } catch { /* the log channel must never be the thing that breaks the app */ }
}

/** Dismiss a relay item ("later / on PC"). The server marks it dismissed and
 *  reflects the change as a `glasses-relay` upsert. */
export async function dismissRelayItem(id: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/glasses/relay/${encodeURIComponent(id)}/dismiss`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`dismiss ${res.status}`)
}
