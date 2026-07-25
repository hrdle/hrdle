// CC Hub API response types (subset relevant to G2 display)

type IndicatorState = 'processing' | 'waiting_input' | 'idle' | 'completed'

export interface Session {
  id: string
  name: string
  state: 'working' | 'idle' | 'lost'
  indicatorState?: IndicatorState
  waitingToolName?: string
  customTitle?: string
  ccSummary?: string
  /** Latest recap (Claude away_summary / /recap; other agents fall back to
   *  their last assistant message). Shown atop the conversation view. */
  ccRecap?: string
  ccFirstPrompt?: string
  ccSessionId?: string
  durationMinutes?: number
  messageCount?: number
  gitBranch?: string
  panes?: { paneId: string; isActive?: boolean; currentCommand?: string }[]
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  toolUse?: { name: string; input?: Record<string, unknown> }[]
  toolResult?: { toolName?: string; output: string; isError?: boolean }[]
}

export interface ConversationResponse {
  messages: ConversationMessage[]
}

export interface SessionsResponse {
  sessions: Session[]
}

export interface DashboardResponse {
  usageLimits: { fiveHour: { utilization: number; timeRemaining: string } } | null
  version?: string
}

// ─── Glasses relay channel (#504) ───
// Mirror of GlassesRelayItem in shared/types.ts (glasses keeps its own subset
// of types and does not import from shared/).

/**
 * Mirror of ClientFocus in shared/types.ts: the session shown on the
 * phone/tablet the user is currently holding. Rides along with
 * `sessions-updated`; absent when every client is hidden, which tells the
 * glasses to keep showing whatever they already had.
 */
export interface ClientFocus {
  sessionId: string
  deviceType: 'mobile' | 'tablet' | 'desktop'
  at: number
}

/**
 * One relay item for the G2 glasses channel: a single piece of information the
 * user needs to make a decision, not a summary. `waiting` items live until the
 * blocked epoch ends or they are dismissed; `info` items are FYI with a TTL.
 */
export interface GlassesRelayItem {
  id: string
  /** Workspace label of the originating session. */
  sessionId: string
  /** tmux pane id ("%N") of the blocked pane — reply routing for multi-pane. */
  paneId?: string
  kind: 'waiting' | 'info'
  /** display-width-clamped text (≈ one G2 page). */
  text: string
  /** Scraped or agent-declared choices; preferred over a terminal re-scrape. */
  choices?: string[]
  source: 'auto' | 'agent'
  /** Dismissed ("later / on PC") — the server reflects these as upserts; the
   *  queue drops them and snapshots never include them. */
  dismissed?: boolean
  createdAt: number
  /** info items only. */
  expiresAt?: number
}

// ─── G2 display helpers ───

/**
 * Strip Markdown / collapse noisy blocks for the G2's plain-text 7-line page.
 * Mechanical only — no semantic summarization (that's the v2 server-side LLM
 * plan). Fenced code and tables collapse to one marker line; emphasis,
 * headers, links and inline-code backticks are unwrapped; blank lines and
 * horizontal rules are dropped (every line is scarce on the glasses).
 */
export function sanitizeForG2(text: string): string {
  const out: string[] = []
  let inCode = false
  let inTable = false
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode
      if (!inCode) out.push('[code]')
      continue
    }
    if (inCode) continue
    const isTableRow = /^\s*\|.*\|?\s*$/.test(raw) && raw.includes('|')
    if (isTableRow) {
      if (!inTable) out.push('[table]')
      inTable = true
      continue
    }
    inTable = false
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '') // headers
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
      .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1') // italic
      .replace(/\b_([^_\n]+)_\b/g, '$1')
      .replace(/`([^`]+)`/g, '$1') // inline code
      .replace(/^\s*>\s?/, '') // blockquote marker
      .replace(/~~([^~]+)~~/g, '$1') // strikethrough
      .trimEnd()
    if (!line.trim()) continue // blank lines / horizontal rules (---, ***)
    if (/^[-*_]{3,}$/.test(line.trim())) continue
    out.push(line)
  }
  if (inCode) out.push('[code]') // unterminated fence
  return out.join('\n')
}

/**
 * Conversation-top recap block (`要約: …` head + ≤maxLines-1 more + separator).
 * Empty when no recap. The glasses conversation view leads with the gist —
 * full history reading is the phone's job (real-device feedback, #504).
 */
export function recapBlockLines(recap: string | undefined, maxLines = 2): string[] {
  const clean = sanitizeForG2((recap ?? '').trim())
  if (!clean) return []
  const lines = clean.split('\n')
  const capped = lines.length > maxLines ? [...lines.slice(0, maxLines - 1), '…'] : lines
  return [`要約: ${capped[0]}`, ...capped.slice(1), '-'.repeat(24)]
}

function shortenPath(p: string): string {
  if (!p) return ''
  const parts = p.split('/')
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p
}

function extractPath(output: string): string {
  const match = output.match(/(?:\/[\w.-]+)+/)
  return match ? shortenPath(match[0]) : ''
}

/** Format a conversation message for G2 display */
export function formatMessage(m: ConversationMessage): string {
  const prefix = m.role === 'user' ? 'U>' : 'A>'
  const textParts: string[] = []
  const toolParts: string[] = []

  // Text content first (Markdown stripped — raw syntax is unreadable on the G2)
  if (m.content?.trim()) {
    const clean = sanitizeForG2(m.content.trim())
    if (clean) textParts.push(clean)
  }

  // Tool use (assistant requesting tools): collapse the run into one summary
  // line. On the G2's 7-line page, per-call detail crowds out the actual text;
  // names + counts carry enough context ("what is it doing").
  if (m.toolUse?.length) {
    const counts = new Map<string, number>()
    for (const t of m.toolUse) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
    const summary = [...counts].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(', ')
    toolParts.push(`[tools] ${summary}`)
  }

  // Tool results (only if no text content — usually filtered out by filterConversation)
  if (!textParts.length && m.toolResult?.length) {
    for (const r of m.toolResult) {
      const name = r.toolName || '?'
      if (name === 'Bash') {
        toolParts.push(`[Bash] ${r.output.slice(0, 80)}`)
      } else {
        const path = extractPath(r.output)
        toolParts.push(`[${name}] ${path || r.output.slice(0, 60)}`)
      }
    }
  }

  // Combine: text first, then tools on new line
  const body = [...textParts, ...(toolParts.length ? [toolParts.join('\n')] : [])]
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim()

  return body ? `${prefix} ${body}` : `${prefix} (empty)`
}
