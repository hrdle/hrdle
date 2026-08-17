// A pane's transcript, in the format the panel reserves for it.
//
// **This is what direct mode shows instead of the terminal itself.** A pane's
// raw output is escape sequences, a TUI's own box drawing and a spinner redrawn
// several times a second; paged seven lines at a time it is unreadable, and it
// is not what someone stepping into a pane is looking for anyway. What they
// want is what the terminal *says*: whose turn it was, what the agent reached
// for, what it answered. That is one reserved line per tool call and the prose
// in between - the same information the terminal carries, in a shape that fits
// a glance.
//
// Carried over from the other glasses app, deliberately unchanged in what it
// produces: `sanitizeForG2` and `formatMessage` from its `types.ts`,
// `filterConversation` from its `controller.ts`. That format was measured on
// the G2 over months of use - which arguments of a tool call are worth the
// line, what a fenced block collapses to, why the agent's turn carries no
// prefix - and re-deriving it here would be re-deriving the same decisions
// worse. Only the paging below is this app's own, because this screen pages by
// a ring gesture rather than by the other app's offset-and-page model.

import { BODY_WIDTH, clipToWidth, splitLines, stripUnrenderable, textWidth } from './metrics.ts'
import type { ConversationMessage } from './types.ts'

// ─── Markdown to plain ───

/** Unwrap inline Markdown - the syntax itself is unreadable on the G2 - and
 *  drop anything the panel has no glyph for. */
function stripInline(raw: string): string {
  return stripUnrenderable(
    raw
      .replace(/^\s{0,3}#{1,6}\s+/, '') // headers
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
      .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1') // italic
      .replace(/\b_([^_\n]+)_\b/g, '$1')
      .replace(/`([^`]+)`/g, '$1') // inline code
      .replace(/^\s*>\s?/, '') // blockquote marker
      .replace(/~~([^~]+)~~/g, '$1') // strikethrough
      .trimEnd(),
  )
}

/**
 * One Markdown table row -> one plain line (`cell | cell`).
 *
 * The whole table used to collapse into a `[table]` marker, which threw the
 * content away and told the reader nothing. Tables in agent replies are nearly
 * always short key/value pairs, which read fine one row per line even at this
 * width. Returns null for the `|---|---|` delimiter row, which has nothing to
 * say without column alignment to describe.
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
 * this size. True of real source with deep indentation and long lines - and
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

  // A line too wide for the panel is wrapped, not thrown away along with the
  // block around it: `[code 2 lines]` was a real screen, and the marker said
  // nothing about either line for want of a line break.
  const wrapped = dedented.flatMap((l) => (textWidth(l) <= BODY_WIDTH ? [l] : splitLines(l)))
  if (wrapped.length <= MAX_CODE_LINES) return wrapped
  // Genuinely too much for an aside. Still worth saying how much was withheld,
  // counted in source lines rather than wrapped ones - which is what the reader
  // would count if they could see it.
  return [`[code ${dedented.length} lines]`]
}

/**
 * Strip Markdown and collapse noisy blocks for the panel's plain-text page.
 *
 * Mechanical only - no summarizing. Fenced code is shown when it fits and
 * counted when it does not; table rows are flattened to text; emphasis,
 * headers, links and inline-code backticks are unwrapped; blank lines and
 * horizontal rules are dropped, because every line is scarce here.
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
    if (!line.trim()) continue
    if (/^[-*_]{3,}$/.test(line.trim())) continue
    out.push(line)
  }
  if (code) out.push(...renderCodeBlock(code)) // unterminated fence
  return out.join('\n')
}

// ─── One message ───

/** Argument names that carry the file a call is about, in the order to prefer them. */
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'target_file', 'target_directory']

/** Argument names that identify or configure rather than describe. */
const SKIP_KEYS = new Set([
  'id',
  'uuid',
  'session_id',
  'sessionId',
  'tool_use_id',
  'toolUseId',
  'task_id',
  'type',
  'format',
  'encoding',
  'model',
  'agent',
  'subagent_type',
])

/**
 * The one thing worth knowing about a tool call.
 *
 * A bare list of tool names (`[Read] [Read] [Bash]`) says nothing about what the
 * agent is doing, which is the only reason to look at this screen.
 *
 * Read by field, not by tool name. Every agent names its arguments differently -
 * Claude reads a `file_path`, Kimi a `path`, Grok a `target_file` - and a switch
 * on the name has to be taught each one. It also fails *silently* when it has
 * not been: `case 'Read'` returning an empty `file_path` shadowed the fallback
 * that would have found `path`, so every Kimi file call read `[Read]` and
 * nothing more.
 *
 * The order is what a reader wants first: an author's own description, then the
 * thing being searched for, then the file, then the instruction given.
 */
function describeToolUse(tool: { name: string; input?: Record<string, unknown> }): string {
  const input = tool.input ?? {}
  const str = (key: string): string => {
    const value = input[key]
    return typeof value === 'string' ? value.trim() : ''
  }

  // Written to be read, by whoever made the call. Nothing derived beats it.
  const description = str('description')
  if (description) return description

  // Ahead of the path deliberately: a Grep carries both, and the pattern is what
  // the call was about while the path is only where it looked.
  const pattern = str('pattern') || str('query')
  if (pattern) return pattern

  for (const key of PATH_KEYS) {
    const path = str(key)
    if (path) return shortenPath(path)
  }

  const rest = str('url') || str('command') || str('prompt')
  if (rest) return rest

  // A tool nobody anticipated still says something about itself: the first short
  // string it was given is usually a name, a path or a query.
  for (const [key, value] of Object.entries(input)) {
    if (SKIP_KEYS.has(key)) continue
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text && text.length <= 120) return text
  }
  return ''
}

function shortenPath(p: string): string {
  if (!p) return ''
  const parts = p.split('/')
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p
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
 * see: the turn that is not marked is the answer to the one that is.
 */
const USER_PREFIX = '$ '
const AGENT_PREFIX = ''

/**
 * Pixels left for a tool call's detail on its own line.
 *
 * The line renders as `[Name] detail`. Clipping to a fixed budget regardless of
 * the label put the line past the panel edge, so the ellipsis wrapped and a
 * two-character stub took a line of its own - on a seven-line screen. Measured,
 * not estimated: `[NotebookEdit] ` is more than twice the width of `[Read] `.
 */
function toolDetailWidth(toolName: string): number {
  return BODY_WIDTH - textWidth(AGENT_PREFIX) - textWidth(`[${toolName}] `)
}

/** One conversation message as the panel draws it. */
export function formatMessage(m: ConversationMessage): string {
  const prefix = m.role === 'user' ? USER_PREFIX : AGENT_PREFIX
  const textParts: string[] = []
  const toolParts: string[] = []

  if (m.content?.trim()) {
    const clean = sanitizeForG2(m.content.trim())
    if (clean) textParts.push(clean)
  }

  // Tool use: one line per call, each saying what it actually did. Capped so a
  // long run cannot push the agent's own words off the page.
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
    if (hidden > 0) toolParts.push(`... +${hidden} more`)
  }

  // Tool results, only where there is no prose to show instead.
  if (!textParts.length && m.toolResult?.length) {
    for (const r of m.toolResult) {
      const name = r.toolName || '?'
      // Command output arrives with its newlines intact; left alone, a single
      // result eats the whole page. Flatten to one line, then clip.
      const flat = r.output.replace(/\s+/g, ' ').trim()
      const detail = name === 'Bash' ? flat : extractPath(r.output) || flat
      toolParts.push(detail ? `[${name}] ${clipToWidth(detail, toolDetailWidth(name))}` : `[${name}]`)
    }
  }

  const body = [...textParts, ...(toolParts.length ? [toolParts.join('\n')] : [])]
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim()

  return body ? `${prefix}${body}` : `${prefix}(empty)`
}

/** Merge an agent's tool-only turn into the words it belongs to, and drop a
 *  message that is nothing but a tool result - the output is truncated to the
 *  point of saying nothing, and the call above it already said what it was. */
export function filterConversation(msgs: ConversationMessage[]): ConversationMessage[] {
  const result: ConversationMessage[] = []
  for (const m of msgs) {
    if (!m.content?.trim() && !m.toolUse?.length && m.toolResult?.length) continue

    if (m.role === 'assistant' && !m.content?.trim() && m.toolUse?.length) {
      const prev = result[result.length - 1]
      if (prev?.role === 'assistant' && prev.content?.trim()) {
        prev.toolUse = [...(prev.toolUse || []), ...m.toolUse]
        continue
      }
    }

    result.push({ ...m })
  }
  return result
}

// ─── Pages ───

/**
 * The transcript cut into pages, newest first.
 *
 * Page 0 is the live end, so the screen opens where the terminal is now and a
 * swipe walks back in time. Whole turns are kept together while they fit, which
 * is what makes the page read as a piece of conversation rather than a window
 * that happened to land where it did; a turn longer than a page gets pages of
 * its own, tiled so that no line is on two of them and none is on neither.
 *
 * **No blank line between turns**, deliberately, and not because of the line it
 * would cost: an empty string does not survive the render, so a separator
 * written that way exists only in this file. The `$` on the user's turn is the
 * boundary, which is the job it was given.
 */
export function conversationPages(msgs: ConversationMessage[], perPage: number): string[][] {
  const room = Math.max(1, perPage)
  const blocks = msgs.map((m) => formatMessage(m).split('\n').flatMap((l) => splitLines(l, BODY_WIDTH)))

  const pages: string[][] = []
  let page: string[] = []

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.length === 0) continue

    if (block.length <= room - page.length) {
      page.unshift(...block)
      continue
    }

    if (page.length > 0) {
      pages.push(page)
      page = []
    }

    if (block.length <= room) {
      page = [...block]
      continue
    }

    // Longer than a page on its own. Tiled from its end, so the page nearest
    // the live edge holds how the turn finished.
    for (let at = block.length; at > 0; at -= room) {
      pages.push(block.slice(Math.max(0, at - room), at))
    }
  }

  if (page.length > 0) pages.push(page)
  return pages
}
