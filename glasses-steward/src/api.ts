// Every request this app makes.
//
// Two halves that are deliberately not mixed: `/api/steward/*` is what the
// steward wrote and what a person answers, and it is the whole of what these
// screens show. The rest - the session list, a raw transcript, a prompt into a
// pane - exists only for direct mode, the one screen the steward does not
// write.

import type {
  ConversationMessage,
  ConversationResponse,
  SessionsResponse,
  StewardAskAnswer,
  StewardSessionLine,
  StewardThreadItem,
  StewardTurn,
} from './types.ts'
import { threadAgentOf } from './types.ts'

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

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json() as Promise<T>
}

// ── the steward ──

/**
 * Whether this server has a steward at all.
 *
 * Answers either way, gate on or off, which is what lets this app tell "the
 * owner has not switched it on" apart from "this server is too old to have any
 * of it". Every other steward route 404s when it is off, and a 404 cannot say
 * which of the two happened.
 */
export async function getStewardEnabled(): Promise<boolean> {
  try {
    const body = await fetchJson<{ enabled?: boolean }>('/api/steward/enabled')
    return body.enabled === true
  } catch {
    return false
  }
}

export function getSteward(): Promise<{ thread: StewardThreadItem[]; lines: StewardSessionLine[] }> {
  return fetchJson('/api/steward')
}

export function getSessionTurns(sessionId: string): Promise<{ turns: StewardTurn[] }> {
  return fetchJson(`/api/steward/sessions/${encodeURIComponent(sessionId)}/turns`)
}

/**
 * Ask for a session the steward has not written yet.
 *
 * Answering with the raw transcript instead is what this avoids: `update_session`
 * writes differences, so a session that is never asked for is never summarised,
 * and falling back would make that permanent. Answers immediately - the writing
 * arrives later, as turns.
 */
export function summariseSession(sessionId: string): Promise<{ turns: StewardTurn[]; asked: boolean }> {
  return postJson(`/api/steward/sessions/${encodeURIComponent(sessionId)}/summarise`)
}

/** Say something to the steward, or answer a question it asked. */
export function replyToSteward(input: {
  text?: string
  askId?: string
  answer?: StewardAskAnswer
  sessionId?: string
}): Promise<{ item: StewardThreadItem }> {
  return postJson('/api/steward/thread/reply', input)
}

/**
 * What was said to a pane without the steward in the loop.
 *
 * Direct mode reaches the agent and not the steward, and an unrecorded
 * instruction leaves the steward watching a pane change state for a reason it
 * cannot account for. Sent alongside the prompt rather than instead of it: the
 * prompt is what makes the agent move, this is what makes the record true.
 */
export function reportSpokenDirectly(sessionId: string, text: string): Promise<{ item: StewardThreadItem }> {
  return postJson(`/api/steward/sessions/${encodeURIComponent(sessionId)}/spoke`, { text })
}

// ── sessions, for direct mode ──

export function getSessions(): Promise<SessionsResponse> {
  return fetchJson('/api/sessions')
}

/** Conversation history for one agent session. A thread agent (kimi/codex/grok)
 *  keeps its transcript in its own store and is only reachable via `?agent=`. */
export async function getConversation(
  sessionId: string,
  last = 10,
  agent?: string,
): Promise<ConversationMessage[]> {
  const thread = threadAgentOf(agent)
  const agentParam = thread ? `&agent=${encodeURIComponent(thread)}` : ''
  try {
    const data = await fetchJson<ConversationResponse>(
      `/api/sessions/history/${encodeURIComponent(sessionId)}/conversation?last=${last}${agentParam}`,
    )
    return data.messages
  } catch {
    return []
  }
}

/** Send a prompt to a session (bracketed paste + Enter server-side = submit). */
export async function sendPrompt(sessionId: string, text: string, paneId?: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(paneId ? { text, paneId } : { text }),
  })
  if (!res.ok) throw new Error(`prompt ${res.status}`)
}

// ── speech ──

/** Raw 16-bit mono PCM to the server for transcription. `sessionId` names the
 *  workspace being spoken about, which leads the vocabulary bias with that
 *  session's own words. */
export async function transcribe(
  pcm: Uint8Array,
  sampleRate = 16000,
  sessionId?: string,
): Promise<string> {
  const body = new Uint8Array(pcm.length)
  body.set(pcm)
  const session = sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''
  const res = await fetch(`${baseUrl}/api/glasses/stt?sampleRate=${sampleRate}${session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: body.buffer,
  })
  if (!res.ok) throw new Error(`STT ${res.status}`)
  const data = (await res.json()) as { text?: string }
  return (data.text || '').trim()
}

// ── diagnostics ──

/**
 * Ship a line to the hub's browser log (`/api/logs`, no auth).
 *
 * The glasses run inside a WebView whose console nobody can reach, so an
 * uncaught exception kills the app with no trace at all. Posts are chained so
 * the log arrives in the order it was written - concurrent posts produced a
 * file where startup milestones were out of sequence, and a log whose order
 * cannot be trusted cannot answer "what happened just before it died".
 */
let logChain: Promise<void> = Promise.resolve()

export function reportLog(level: string, message: string, stack?: string): Promise<void> {
  if (!baseUrl) return Promise.resolve()
  logChain = logChain.then(async () => {
    try {
      await fetch(`${baseUrl}/api/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level,
          message: `[steward-glasses] ${message}`,
          timestamp: new Date().toISOString(),
          stack,
        }),
      })
    } catch {
      /* the log channel must never be the thing that breaks the app */
    }
  })
  return logChain
}
