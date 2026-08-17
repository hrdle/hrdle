// What the server sends, as this app needs it.
//
// Mirrored from `shared/types.ts` rather than imported: that module pulls in
// zod, and this bundle is shipped to the glasses where every KB is dead weight.
// The same trade the other glasses app makes, for the same reason.

/** One event the steward wrote, twice: `text` for this panel's one page,
 *  `detail` for a phone that can hold code and diffs. The glasses never read
 *  `detail` - "continue on mobile" is that field being present. */
export interface StewardTurn {
  id: string
  at: number
  role: 'agent' | 'user' | 'steward'
  text: string
  detail?: string
  images?: string[]
  refs?: { file?: string; line?: number; url?: string }
  /** Where in the real transcript this was summarised from. The glasses have
   *  nowhere to open it; carried so a frame can be compared against a phone. */
  source?: { agentSessionId: string; messageIds?: string[] }
}

export type StewardAskAnswer =
  | { kind: 'choice'; indices: number[] }
  | { kind: 'text'; text: string }
  /** Walked away. A value rather than an absent answer, or an abandoned
   *  question reads as still pending on every wake-up. */
  | { kind: 'dismissed' }

export interface StewardAsk {
  id: string
  mode: 'single' | 'multi' | 'freeText'
  choices: string[]
  /** Position in a chain, e.g. 2 of 3. Steps are separate asks. */
  step?: { index: number; total: number }
  answer?: StewardAskAnswer
  answeredAt?: number
}

export type StewardThreadItem = StewardTurn & {
  /** Which session this entry is about, when it is about one. */
  sessionId?: string
} & (
    | { kind: 'notify' }
    | { kind: 'ask'; ask: StewardAsk }
    | { kind: 'report'; rows: string[] }
    | { kind: 'reply'; askId?: string }
  )

export interface StewardSessionLine {
  sessionId: string
  text: string
  at: number
}

type IndicatorState = 'processing' | 'waiting_input' | 'idle' | 'completed'

/**
 * A workspace, as far as this app is concerned.
 *
 * Far less than the other app reads. Everything shown about a session on these
 * screens is written by the steward; what is still needed from the session list
 * is the **name** (the steward addresses sessions by id, and an id is not a
 * thing to read), the **order** (herdr's workspace order, which is where the
 * steward's own reordering will land - see the ordering note in `controller`),
 * and the **pane** to speak to in direct mode.
 */
export interface Session {
  id: string
  name: string
  customTitle?: string
  agent?: string
  agentSessionId?: string
  indicatorState?: IndicatorState
  panes?: Pane[]
}

export interface Pane {
  paneId: string
  isActive?: boolean
  agent?: string
  agentSessionId?: string
  indicatorState?: IndicatorState
}

export interface SessionsResponse {
  sessions: Session[]
}

/** One message of a raw transcript, for direct mode. */
export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
  toolUse?: { name: string; input?: Record<string, unknown> }[]
  toolResult?: { toolName?: string; output: string; isError?: boolean }[]
}

export interface ConversationResponse {
  messages: ConversationMessage[]
}

/** Thread-based agents - everything that is not Claude. Their transcript is
 *  only reachable by naming them. Mirrors `threadAgentOf` in shared/types.ts. */
export function threadAgentOf(agent: string | undefined): string | undefined {
  return agent && agent !== 'claude' ? agent : undefined
}

/** What a session is called, for a person reading a list of them. */
export function sessionName(session: Session): string {
  return session.customTitle || session.name || session.id
}

/**
 * The steward's line for a session, or nothing.
 *
 * Nothing is the ordinary case for a session it has not reached yet, and it is
 * drawn as such - not as an error, and not by falling back to a recap. Falling
 * back is how the other app's list works and is exactly what this one replaces:
 * a screen where half the rows are the steward's words and half are scraped
 * ones reads as neither.
 */
export function lineFor(lines: StewardSessionLine[], sessionId: string): string | undefined {
  return lines.find((l) => l.sessionId === sessionId)?.text
}

/** Questions still waiting, oldest first. */
export function pendingAsks(thread: StewardThreadItem[]): StewardThreadItem[] {
  return thread.filter((i) => i.kind === 'ask' && !i.ask.answer)
}

/** The newest report, which is the whole of what the report screen shows. */
export function latestReport(thread: StewardThreadItem[]): StewardThreadItem | undefined {
  for (let i = thread.length - 1; i >= 0; i--) {
    const item = thread[i]
    if (item?.kind === 'report') return item
  }
  return undefined
}

/**
 * Which session a report row is about.
 *
 * The rows are strings the steward wrote (`work-1  waiting on review  12m`),
 * so the link back to a session is a match on the leading token rather than a
 * field. A row that matches nothing is drawn and simply cannot be opened -
 * better than opening the wrong session, and better than refusing to show a row
 * because this app could not parse it.
 *
 * Structured rows would end the guessing and are worth doing; they change the
 * store's shape, so they are not smuggled in here.
 */
export function sessionOfRow(row: string, sessions: Session[]): Session | undefined {
  const head = row.trim().split(/\s+/)[0]
  if (!head) return undefined
  return sessions.find((s) => s.id === head || sessionName(s) === head || s.name === head)
}
