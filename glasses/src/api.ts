import type {
  SessionsResponse,
  DashboardResponse,
  ConversationResponse,
  ConversationMessage,
  RecordedGlassesLine,
  RecordingDaySummary,
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

export function getSessions(): Promise<SessionsResponse> {
  return fetchJson('/api/sessions')
}

export function getDashboard(): Promise<DashboardResponse> {
  return fetchJson('/api/dashboard')
}

/** Days with screen-mirror recordings, for the replay player. */
export function getRecordingDays(): Promise<{ enabled: boolean; days: RecordingDaySummary[] }> {
  return fetchJson('/api/glasses/recording')
}

/** All recorded lines of one day, in recorded order. */
export function getRecordingDay(day: string): Promise<{ day: string; lines: RecordedGlassesLine[] }> {
  return fetchJson(`/api/glasses/recording/${encodeURIComponent(day)}`)
}

/** Conversation history for one agent session.
 *
 *  `agent` names the reader on the server side: a thread agent (kimi/codex/grok)
 *  keeps its transcript in its own store and is only reachable via `?agent=`.
 *  Omitted — or Claude — the server reads Claude's jsonl, which is the right
 *  default and the wrong answer for everyone else. */
export async function getConversation(
  sessionId: string,
  last = 10,
  agent?: string
): Promise<ConversationMessage[]> {
  const thread = threadAgentOf(agent)
  const agentParam = thread ? `&agent=${encodeURIComponent(thread)}` : ''
  try {
    const data = await fetchJson<ConversationResponse>(
      `/api/sessions/history/${encodeURIComponent(sessionId)}/conversation?last=${last}${agentParam}`
    )
    return data.messages
  } catch {
    return []
  }
}

/** Send raw 16-bit mono PCM to the server for Groq transcription. Returns the recognized text.
 *  `sessionId` names the workspace being spoken to, so the server can lead the
 *  vocabulary bias with that session's own words. */
export async function transcribe(
  pcm: Uint8Array,
  sampleRate = 16000,
  sessionId?: string
): Promise<string> {
  // Copy into a tightly-sized ArrayBuffer so the fetch body types cleanly.
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

/** Send a free-text prompt to a session (bracketed paste + Enter server-side = submit).
 *  `paneId` targets a specific pane (glasses relay reply routing): in a
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
 *  where the item carries the exact blocked paneId. */
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
/**
 * Posts are chained so the log arrives in the order it was written.
 *
 * They used to go out concurrently, and the file showed it: `page container
 * created` printed before the `main:` line of the same run, startup milestones
 * out of sequence. A log whose order cannot be trusted cannot answer "what
 * happened just before it died", which is the only question being asked of it.
 *
 * One in-flight request at a time. The queue is a promise chain rather than an
 * array because nothing here needs to inspect or drop entries — and a failure
 * must not break the chain, hence the swallow inside the link.
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
          message: `[glasses] ${message}`,
          timestamp: new Date().toISOString(),
          stack,
        }),
      })
    } catch { /* the log channel must never be the thing that breaks the app */ }
  })
  return logChain
}

/** Dismiss a relay item ("later / on PC"). The server marks it dismissed and
 *  reflects the change as a `glasses-relay` upsert. */
export async function dismissRelayItem(id: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/glasses/relay/${encodeURIComponent(id)}/dismiss`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`dismiss ${res.status}`)
}

/**
 * What the settings screen may see. The Groq key is write-only, so it is not here.
 *
 * Nor is the prompt that would be sent: this screen has no session, so it never
 * had one to show. Ask `getSttPreview()` for that.
 */
export interface GlassesSettingsView {
  hasApiKey: boolean
  apiKeySource: 'setting' | 'env' | 'none'
  sttLang: string
  sttLangSource: 'setting' | 'default'
  /** Whether a vocabulary prompt is sent at all. */
  sttBias: boolean
  /** `env` is `HRDLE_STT_PROMPT=off`, which this screen cannot switch back on. */
  sttBiasSource: 'setting' | 'env' | 'default'
  sttModel: string
  sttModelSource: 'setting' | 'default'
  /** Every model the server will accept, so this app need not hardcode them. */
  sttModels: string[]
  /** Seconds before this app blanks its panel; `0` = never. */
  screenOffSeconds: number
  screenOffSecondsSource: 'setting' | 'default'
}

/**
 * What a transcription would carry, for a session and a language.
 *
 * The same object the transcription itself resolves, so this is the answer to
 * "what is being sent right now" rather than a second guess at it.
 */
export interface SttRequestPreview {
  model: string
  modelSource: 'setting' | 'default'
  /** `null` sends no language and lets Whisper detect it. */
  language: string | null
  languageSource: 'request' | 'setting' | 'default'
  /** `null` sends no vocabulary prompt at all. */
  prompt: string | null
  promptSource: 'composed' | 'env' | 'off'
  promptComposition: {
    prompt: string
    groups: Array<{
      name: 'session' | 'glossary'
      budget: number
      taken: string[]
      skipped: Array<{ term: string; reason: 'budget' | 'duplicate' }>
    }>
    usedChars: number
    maxChars: number
  } | null
  sessionId: string | null
}

export function getGlassesSettings(): Promise<GlassesSettingsView> {
  return fetchJson('/api/glasses/settings')
}

/** What would be sent with an utterance from `session`, right now. */
export function getSttPreview(session?: string, lang?: string): Promise<SttRequestPreview> {
  const query = new URLSearchParams()
  if (session) query.set('session', session)
  if (lang) query.set('lang', lang)
  const suffix = query.toString()
  return fetchJson(`/api/glasses/stt-preview${suffix ? `?${suffix}` : ''}`)
}

/** Patch the settings. `null` clears a field; omitting it leaves that one alone. */
export async function putGlassesSettings(patch: {
  groqApiKey?: string | null
  sttLang?: string | null
  sttBias?: 'on' | 'off' | null
  sttModel?: string | null
  screenOffSeconds?: number | null
}): Promise<GlassesSettingsView> {
  const res = await fetch(`${baseUrl}/api/glasses/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(detail.error || `settings ${res.status}`)
  }
  return res.json() as Promise<GlassesSettingsView>
}
