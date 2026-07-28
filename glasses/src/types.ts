// CC Hub API response types (subset relevant to G2 display)
import { BODY_WIDTH, clipToWidth, stripUnrenderable, textWidth } from './metrics.ts'

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
  /** When the recap was written. The conversation is compared against it: a
   *  message newer than the recap means the reader is already past it. */
  ccRecapAt?: string
  /** Tab the terminal is showing. Panes outside it are marked in the list. */
  activeTabId?: string
  ccFirstPrompt?: string
  ccSessionId?: string
  durationMinutes?: number
  messageCount?: number
  gitBranch?: string
  panes?: Pane[]
}

/**
 * A pane, as the server already describes it.
 *
 * The glasses used to declare three of these fields and drop the rest, which
 * hid the one that matters: `indicatorState` is per pane, and which pane is
 * blocked is a question a workspace-level status cannot answer. Each agent
 * pane is also its own conversation — `agentSessionId` differs between panes
 * of the same workspace — so a workspace with two panes was showing one of
 * them and silently omitting the other.
 */
export interface Pane {
  paneId: string
  isActive?: boolean
  /** Tab the pane belongs to. `panes` spans every tab of the workspace, so a
   *  pane whose tab is not the active one is running out of sight of the
   *  terminal — still a live agent, and now reachable from here. */
  tabId?: string
  /** Name the user gave the pane (`herdr pane rename`). Absent until they do. */
  label?: string
  currentCommand?: string
  currentPath?: string
  agent?: string
  /** Native agent session id. Distinct per pane; the conversation key. */
  agentSessionId?: string
  indicatorState?: IndicatorState
  waitingToolName?: string
  /** Per-pane recap, sent only for multi-pane workspaces. */
  recap?: string
  recapAt?: string
  metrics?: { contextPercent?: number }
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  /** ISO 8601, as the history API sends it. */
  timestamp?: string
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
 * Mirror of GlassesScreen in shared/types.ts: the three container strings the
 * panel is showing. The device publishes it; the simulator draws it.
 */
export interface GlassesScreen {
  header: string
  body: string
  footer: string
  mode: string
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

/** Unwrap inline Markdown — the syntax itself is unreadable on the G2 — and
 *  drop anything the panel has no glyph for. */
function stripInline(raw: string): string {
  return stripUnrenderable(
    raw
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
  )
}

/**
 * One Markdown table row → one plain line (`cell | cell`).
 *
 * The whole table used to collapse into a `[table]` marker, which threw the
 * content away and told the reader nothing — the marker itself carries no
 * information (real-device feedback). Tables in agent replies are nearly
 * always short key/value pairs, which read fine one row per line even at 52
 * columns. Returns null for the `|---|---|` delimiter row, which has nothing
 * to say without column alignment to describe.
 */
function tableRowToLine(raw: string): string | null {
  const cells = raw
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
  if (cells.every((c) => /^:?-+:?$/.test(c))) return null
  const kept = cells.filter((c) => c !== '')
  return kept.length ? kept.join(' | ') : null
}

/** Lines a fenced block may take before it stops being an aside and starts
 *  being the page. Four leaves three for the prose around it. */
const MAX_CODE_LINES = 4

/**
 * A fenced block, shown when it can be shown.
 *
 * It used to collapse to `[code]` on the grounds that source is unreadable at
 * this size. True of real source with deep indentation and long lines — and
 * false of most fenced blocks in agent replies, which are a command, a couple
 * of values, a short listing. Those fit the panel with room to spare, and
 * throwing them away took the content a sentence had just promised.
 *
 * Common indentation goes first: on a panel this narrow, four leading spaces
 * are the difference between fitting and not, and dropping the shared prefix
 * keeps every line's relation to the others intact.
 */
function renderCodeBlock(lines: string[]): string[] {
  const body = [...lines]
  while (body.length && !body[0].trim()) body.shift()
  while (body.length && !body[body.length - 1].trim()) body.pop()
  if (!body.length) return []

  const filled = body.filter((l) => l.trim())
  const indent = Math.min(...filled.map((l) => (l.match(/^ */) as RegExpMatchArray)[0].length))
  const dedented = body.map((l) => stripUnrenderable(l.slice(indent)))

  const fits = dedented.length <= MAX_CODE_LINES && dedented.every((l) => textWidth(l) <= BODY_WIDTH)
  // Still worth saying how much was withheld — `[code]` alone said only that
  // something was there.
  return fits ? dedented : [`[code ${dedented.length}行]`]
}

/**
 * Strip Markdown / collapse noisy blocks for the G2's plain-text 7-line page.
 * Mechanical only — no semantic summarization (that's the v2 server-side LLM
 * plan). Fenced code is shown when it fits and summarised when it does not;
 * table rows are flattened to text; emphasis, headers, links and
 * inline-code backticks are unwrapped; blank lines and horizontal rules are
 * dropped (every line is scarce on the glasses).
 */
export function sanitizeForG2(text: string): string {
  const out: string[] = []
  let code: string[] | null = null
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) {
      if (code) {
        out.push(...renderCodeBlock(code))
        code = null
      } else {
        code = []
      }
      continue
    }
    if (code) {
      code.push(raw)
      continue
    }
    if (/^\s*\|.*\|?\s*$/.test(raw) && raw.includes('|')) {
      const row = tableRowToLine(raw)
      if (row) out.push(stripInline(row))
      continue
    }
    const line = stripInline(raw)
    if (!line.trim()) continue // blank lines / horizontal rules (---, ***)
    if (/^[-*_]{3,}$/.test(line.trim())) continue
    out.push(line)
  }
  if (code) out.push(...renderCodeBlock(code)) // unterminated fence
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


/**
 * The one thing worth knowing about a tool call.
 *
 * A bare list of tool names ("[tools] Bash, Bash, Read") says nothing about
 * what the agent is doing, which is the only reason to look at this screen.
 * Bash carries a human-written `description` — use it over the command, since
 * it is already a sentence about intent rather than shell to decipher.
 */
function describeToolUse(tool: { name: string; input?: Record<string, unknown> }): string {
  const input = tool.input ?? {}
  const str = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')

  switch (tool.name) {
    case 'Bash':
      return str('description') || str('command')
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return shortenPath(str('file_path'))
    case 'Grep':
    case 'Glob':
      return str('pattern')
    case 'Task':
    case 'Agent':
      return str('description')
    case 'WebFetch':
      return str('url')
    case 'WebSearch':
      return str('query')
    case 'TodoWrite':
      return ''
    default: {
      // Unknown tool: the first non-empty string argument is usually the
      // interesting one (a path, a query, a name).
      for (const value of Object.values(input)) {
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
      return ''
    }
  }
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

/**
 * What marks whose turn it is.
 *
 * `$` for the user, the way a shell marks a prompt, and nothing at all for the
 * agent. Every line is scarce on a seven-line screen, and an `A>` in front of
 * every assistant message spends columns on something the reader can already
 * see: the turn that is not marked is the answer to the one that is. Messages
 * are separated by a blank line in the multi-message view, so the boundary
 * survives without a label.
 */
const USER_PREFIX = '$ '
const AGENT_PREFIX = ''

/**
 * Pixels left for a tool call's detail on its own line.
 *
 * The line renders as `[Name] detail`. Clipping to a fixed budget regardless
 * of the label put the line past the panel edge, so the ellipsis wrapped and a
 * two-character stub (`'…`) took a line of its own — on a seven-line screen.
 * Measured, not estimated: `[NotebookEdit] ` is more than twice the width of
 * `[Read] `. Tool lines belong to agent turns, which carry no prefix.
 */
function toolDetailWidth(toolName: string): number {
  return BODY_WIDTH - textWidth(AGENT_PREFIX) - textWidth(`[${toolName}] `)
}

/** Format a conversation message for G2 display */
export function formatMessage(m: ConversationMessage): string {
  const prefix = m.role === 'user' ? USER_PREFIX : AGENT_PREFIX
  const textParts: string[] = []
  const toolParts: string[] = []

  // Text content first (Markdown stripped — raw syntax is unreadable on the G2)
  if (m.content?.trim()) {
    const clean = sanitizeForG2(m.content.trim())
    if (clean) textParts.push(clean)
  }

  // Tool use: one line per call, each saying what it actually did. Capped so a
  // long run cannot push the assistant's own words off the 7-line page.
  if (m.toolUse?.length) {
    const MAX_TOOL_LINES = 4
    for (const tool of m.toolUse.slice(0, MAX_TOOL_LINES)) {
      // Flattened first: a heredoc or a multi-line command otherwise keeps its
      // newlines and one call eats three of the seven lines on screen.
      const raw = sanitizeForG2(describeToolUse(tool)).replace(/\s+/g, ' ').trim()
      const detail = clipToWidth(raw, toolDetailWidth(tool.name))
      toolParts.push(detail ? `[${tool.name}] ${detail}` : `[${tool.name}]`)
    }
    const hidden = m.toolUse.length - MAX_TOOL_LINES
    if (hidden > 0) toolParts.push(`… 他${hidden}件`)
  }

  // Tool results (only if no text content — usually filtered out by filterConversation)
  if (!textParts.length && m.toolResult?.length) {
    for (const r of m.toolResult) {
      const name = r.toolName || '?'
      // Command output arrives with its newlines intact; left alone, a single
      // result eats the whole 7-line page. Flatten to one line, then clip.
      const flat = r.output.replace(/\s+/g, ' ').trim()
      const detail = name === 'Bash' ? flat : extractPath(r.output) || flat
      toolParts.push(detail ? `[${name}] ${clipToWidth(detail, toolDetailWidth(name))}` : `[${name}]`)
    }
  }

  // Combine: text first, then tools on new line
  const body = [...textParts, ...(toolParts.length ? [toolParts.join('\n')] : [])]
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim()

  return body ? `${prefix}${body}` : `${prefix}(empty)`
}
