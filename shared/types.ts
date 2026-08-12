import { z } from 'zod';

// =============================================================================
// Session State
// =============================================================================

export type SessionState =
  | 'idle'
  | 'working'
  | 'waiting_input'
  | 'waiting_permission'
  | 'disconnected'
  | 'lost';

// =============================================================================
// Entities
// =============================================================================

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

export interface Session {
  id: string;
  name: string;
  createdAt: string;
  lastAccessedAt: string;
  state: SessionState;
  ownerId: string;
}


// =============================================================================
// API Response Types
// =============================================================================

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    username: string;
  };
}

// Session theme colors
export type SessionTheme = 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'blue' | 'indigo' | 'purple' | 'pink';

export const AGENT_PROVIDERS = {
  claude: {
    id: 'claude',
    command: 'claude',
    resumeCommand: 'claude -r',
    labelKey: 'session.agentProvider.claude',
    displayName: 'Claude',
    processPatterns: [/(?:^|\/)claude(?:\s|$)/, /\/claude\/versions\//],
    supportsConversationMetadata: true,
  },
  codex: {
    id: 'codex',
    command: 'codex',
    resumeCommand: 'codex resume',
    labelKey: 'session.agentProvider.codex',
    displayName: 'Codex',
    processPatterns: [/(?:^|\/)codex(?:\s|$)/, /\/@openai\/codex\//],
    supportsConversationMetadata: false,
  },
  grok: {
    id: 'grok',
    command: 'grok',
    resumeCommand: 'grok --resume',
    labelKey: 'session.agentProvider.grok',
    displayName: 'Grok',
    processPatterns: [/(?:^|\/)grok(?:\s|$)/],
    supportsConversationMetadata: false,
  },
  kimi: {
    id: 'kimi',
    command: 'kimi',
    resumeCommand: 'kimi --session',
    labelKey: 'session.agentProvider.kimi',
    displayName: 'Kimi',
    processPatterns: [/(?:^|\/)kimi(?:\s|$)/],
    supportsConversationMetadata: false,
  },
  opencode: {
    id: 'opencode',
    command: 'opencode',
    resumeCommand: 'opencode --session',
    labelKey: 'session.agentProvider.opencode',
    displayName: 'OpenCode',
    processPatterns: [/(?:^|\/)opencode(?:\s|$)/],
    supportsConversationMetadata: false,
  },
} as const;

export type AgentProvider = keyof typeof AGENT_PROVIDERS;
export const AGENT_PROVIDER_IDS = Object.keys(AGENT_PROVIDERS) as [AgentProvider, ...AgentProvider[]];
export const DEFAULT_AGENT_PROVIDER: AgentProvider = 'claude';

export function isAgentProvider(value: string): value is AgentProvider {
  return value in AGENT_PROVIDERS;
}

export function detectAgentProviderFromArgs(args: string): AgentProvider | undefined {
  for (const agent of Object.values(AGENT_PROVIDERS)) {
    if (agent.processPatterns.some(pattern => pattern.test(args))) {
      return agent.id;
    }
  }
  return undefined;
}

export function agentSupportsConversationMetadata(agent: string | undefined): boolean {
  return !!agent && isAgentProvider(agent) && AGENT_PROVIDERS[agent].supportsConversationMetadata;
}

/**
 * Thread-based agents (everything except Claude): their conversation and
 * identity come from the agent's own session store, keyed by `agentSessionId`,
 * and the conversation is read via HTTP polling instead of the Claude
 * WebSocket stream. Returns the provider id, or undefined for Claude /
 * unknown commands — so it doubles as both a predicate and a narrowing cast.
 */
export function threadAgentOf(agent: string | undefined): AgentProvider | undefined {
  if (!agent || !isAgentProvider(agent)) return undefined;
  return AGENT_PROVIDERS[agent].supportsConversationMetadata ? undefined : agent;
}

/** Human-readable provider name; unknown/undefined falls back to Claude. */
export function agentDisplayName(agent: string | undefined): string {
  return agent && isAgentProvider(agent)
    ? AGENT_PROVIDERS[agent].displayName
    : AGENT_PROVIDERS.claude.displayName;
}

export function agentResumeCommand(agent: AgentProvider, sessionId?: string): string {
  const base = AGENT_PROVIDERS[agent].resumeCommand;
  if (!sessionId) return base;
  // The command is typed into an interactive shell over the pane's control stream, so the
  // session id is single-quoted to guarantee it cannot break out of the
  // argument — defense-in-depth on top of SessionIdSchema at the routes.
  const quoted = `'${sessionId.replace(/'/g, `'\\''`)}'`;
  return `${base} ${quoted}`;
}

export interface SessionResponse {
  id: string;
  name: string;
  /** Immutable identity of this live session instance. A session name can be
   *  deleted and reused; clients use this value to discard the old terminal. */
  instanceId?: string;
  createdAt: string;
  lastAccessedAt: string;
  state: SessionState;
  currentPath?: string;
  agent?: AgentProvider;
  theme?: SessionTheme;
  /** Legacy: servers before the rename write-through stored a display title of
   *  their own. Current servers never set it — the name (herdr workspace
   *  label) is the title — but a peer on an older version still might. */
  customTitle?: string;
  /**
   * Words this session's speech is made of, leading the vocabulary bias sent
   * with its transcriptions. Absent when it has none of its own.
   */
  sttPrompt?: string;
}

export interface SessionListResponse {
  sessions: SessionResponse[];
}

/** One tab of a workspace (herdr workspace > tab > pane). Surfaced so the UI
 *  can list a multi-tab workspace's tabs and switch between them. */
export interface TabInfo {
  /** herdr tab id (e.g. "w1:t2"); echoed back to select/close the tab. */
  id: string;
  /** Display label — herdr's tab number by default, or a custom rename. */
  label: string;
  paneCount: number;
  active: boolean;
}

export interface ErrorResponse {
  error: string;
  code?: string;
}

// =============================================================================
// Validation Schemas
// =============================================================================

// Simple password-only login (for server password auth)
export const LoginSchema = z.object({
  password: z.string().min(1),
});


// Pane ID validation (e.g., "%0", "%1", "%A").
//
// NOT digits only: a pane id is herdr's own pane token behind a `%`, and that
// token is base36 — the tenth pane of a workspace is `pA`, not `p10`. While
// this was `/^%\d+$/` every pane past the ninth was rejected at the boundary
// and dropped by toTmuxPaneId, so splitting a busy workspace created a pane in
// herdr that no layout, viewport or input path could ever address.
export const PaneIdSchema = z.string().regex(/^%[0-9A-Za-z]+$/, 'Invalid pane ID');

// herdr tab id validation (e.g. "w1:t2", "w1W:t3"). Server-provided and echoed
// back by the client to select/close a tab; bounded to the herdr id shape.
export const TabIdSchema = z.string().regex(/^[A-Za-z0-9]+:t\d+$/, 'Invalid tab ID');

// Agent session id validation. Claude/Codex session ids are UUID-like; this
// also bounds them to shell-safe characters because the id is typed into an
// interactive shell via `claude -r <id>` / `codex resume <id>`.
export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/, 'Invalid session id');

export interface PaneInfo {
  paneId: string;          // "%0", "%1"
  currentCommand?: string;
  currentPath?: string;
  /** Agent provider reported by herdr for this pane. */
  agent?: AgentProvider;
  /** Native agent session id reported by the pane's herdr integration. */
  agentSessionId?: string;
  agentName?: string;      // Team agent name from --agent-name process arg
  agentColor?: string;     // Team agent color from --agent-color process arg
  isActive: boolean;
  /** Tab this pane belongs to. `panes` spans every tab of the workspace, so a
   *  consumer describing the terminal — which renders one tab — filters on
   *  this against the session's `activeTabId`. */
  tabId?: string;
  /**
   * Name the user gave this pane with `herdr pane rename`.
   *
   * Absent until they set one, so anything showing it needs a fallback — the
   * pane id is what a pane is called before it is called anything else. herdr
   * owns this; hrdle only relays it, so renaming from either side agrees.
   */
  label?: string;
  indicatorState?: IndicatorState;
  pid?: number;            // shell/subprocess PID of the pane's foreground group
  /** Per-pane agent metrics (model / context% / memory). Populated only for
   *  agent panes of a multi-pane/multi-tab workspace, where a single
   *  workspace-level summary would be ambiguous; simple single-pane workspaces
   *  keep the summary on the card header instead. */
  metrics?: SessionMetrics;
  /** Per-pane Claude recap (away summary), same multi-workspace-only rule as
   *  `metrics` — the header recap is hidden and each Claude pane shows its own. */
  recap?: string;
  recapAt?: string;
  /**
   * The question this pane is waiting on, as the agent itself recorded it.
   *
   * Everything shown about a question was read off the pane until now: a line
   * ending in `?`, rows that look like a list, and - failing both - a row
   * where exactly one item is painted differently from its neighbours. That
   * last rule is a guess about pixels, and on 2026-08-08 it guessed wrong on a
   * Claude pane that was not asking anything: a `Read` result held a line
   * number and a line of code on one row, and a wearer was offered
   * `1039 / const pane = state.selectedPaneId` to choose between. It had
   * already offered a kimi question's own tab bar as that question's answer.
   *
   * Claude writes the `AskUserQuestion` call into its transcript and kimi
   * writes `interaction.request` into its wire, both with the options and
   * their descriptions, in files this server already reads. A client that has
   * this does not have to recognise a menu; it is told what the menu is.
   *
   * Read only while the pane is waiting - the transcript tail is not worth
   * opening every five seconds for every pane on the machine.
   */
  pendingQuestion?: PendingQuestion;
  /**
   * Whether this pane's agent keeps a record that could be read.
   *
   * `false` means the screen is still the only source (codex, grok, opencode).
   * `true` with no `pendingQuestion` is the agent saying nothing is being
   * asked, which is what lets a client refuse a menu it thinks it can see. It
   * does **not** mean nothing is waiting: a permission prompt is not a
   * question and is not in any of these records.
   */
  questionKnown?: boolean;
}

/** A question an agent recorded, with the options as it wrote them. */
export interface PendingQuestion {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  /**
   * The call carried more than one question, so the pane is drawing a tab per
   * question and answering whichever is in front. Which one that is exists
   * only on the screen, so a client must not assume this is the one showing.
   */
  ambiguous: boolean;
}

export interface SessionMetrics {
  contextTokens?: number;              // current context window size (last assistant message sum)
  contextMaxTokens?: number;           // model-specific max (from Anthropic /v1/models)
  contextPercent?: number;             // 0-100
  totalInputTokens?: number;           // cumulative uncached input tokens
  totalCacheCreationTokens?: number;   // cumulative cache creation tokens
  totalCacheReadTokens?: number;       // cumulative cache read tokens
  totalOutputTokens?: number;          // cumulative output tokens
  totalTokens?: number;                // effective usage: input + cache_creation + output (cache_read excluded)
  memoryRssBytes?: number;             // total RSS across session's panes
  model?: string;                      // latest model id used by the agent (e.g. "claude-opus-4-8", "gpt-5.6-sol")
}

// Session names become herdr workspace labels. Keep them in the same
// alphabet as SessionIdSchema so a label stays safe to use wherever a
// session id appears (URLs, logs, RPC params) without escaping.
export const CreateSessionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Session name must be alphanumerics, dot, underscore, or hyphen')
    .optional(),
  workingDir: z.string().optional(),
  initialPrompt: z.string().max(1000).optional(),
  agent: z.enum(AGENT_PROVIDER_IDS).optional().default(DEFAULT_AGENT_PROVIDER),
});

export const ResizeTerminalSchema = z.object({
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
});


// Type inference from schemas
export type LoginInput = z.infer<typeof LoginSchema>;
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;
export type ResizeTerminalInput = z.infer<typeof ResizeTerminalSchema>;

// =============================================================================
// Peer (multi-server) Types
// =============================================================================

// "self" is a pseudo URL meaning the hub itself; the frontend resolves it to window.origin
export const SELF_PEER_URL = 'self' as const;
export const LOCAL_PEER_ID = 'local' as const;

/** Compare peer ids treating unset / 'local' as the same (the local Hub).
 *  Session ids are herdr workspace labels and can collide across peers, so
 *  any session lookup by id must also match on the owning peer. */
export function samePeerId(a?: string | null, b?: string | null): boolean {
  return (a ?? LOCAL_PEER_ID) === (b ?? LOCAL_PEER_ID);
}

export type PeerStatus = 'online' | 'offline' | 'unauthorized' | 'unknown';

export interface Peer {
  id: string;          // 'local' or 'p_xxxx'
  nickname: string;    // Display name (emoji allowed)
  url: string;         // 'self' or 'https://host:port'
  color: string;       // '#RRGGBB' badge color
  order: number;       // Display order
}

// Peer info handed to the client (includes wsToken)
export interface PeerClientView extends Peer {
  wsToken?: string;      // Bearer token for connecting a WS straight to the peer (not needed for self)
  status: PeerStatus;
  lastSeenAt?: string;   // ISO8601
  latencyMs?: number;    // Latency measured by the most recent verify
  errorMessage?: string; // Why it is unauthorized, offline, ...
}

export interface PeerListResponse {
  peers: PeerClientView[];
}

// An entry of the merged session list. The peer fields live directly on ExtendedSessionResponse
export type PeerSession = ExtendedSessionResponse & { peerId: string };

export interface PeerSessionsResponse {
  sessions: PeerSession[];
  // Per-peer errors, so one peer being down still lets the rest render
  errors?: { peerId: string; message: string }[];
}

export interface DiscoveredPeer {
  /** Short host name as Tailscale reports it */
  displayName: string;
  /** Tailscale MagicDNS name */
  hostname: string;
  /** Discovered URL (default port) */
  url: string;
  /** hrdle version */
  version?: string;
  /** Whether it is already registered in peers.json */
  alreadyRegistered: boolean;
  /** Its nickname, when already registered */
  registeredAs?: string;
}

export interface PeerDiscoverResponse {
  discovered: DiscoveredPeer[];
}

export const PeerCreateSchema = z.object({
  nickname: z.string().min(1).max(64),
  // Must be https. The backend additionally rejects loopback/link-local/
  // private hosts at fetch time to block SSRF (Tailscale ranges stay allowed).
  url: z.url().refine(
    (u) => {
      try {
        return new URL(u).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'A peer URL must be https' },
  ),
  // When the peer has auth disabled (no password set) the client need not send
  // one: loginToPeer reads 400 as "auth disabled" and returns an empty token
  password: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const PeerUpdateSchema = z.object({
  nickname: z.string().min(1).max(64).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  password: z.string().min(1).optional(),  // For re-authentication
});

export const PeerOrderSchema = z.object({
  order: z.array(z.string()),  // Array of peer ids
});

// Cross-peer session display order. Each entry is `${peerId}:${sessionId}`.
export const CrossPeerSessionOrderSchema = z.object({
  order: z.array(z.string()),
});

export type PeerCreateInput = z.infer<typeof PeerCreateSchema>;
export type PeerUpdateInput = z.infer<typeof PeerUpdateSchema>;
export type PeerOrderInput = z.infer<typeof PeerOrderSchema>;
export type CrossPeerSessionOrderInput = z.infer<typeof CrossPeerSessionOrderSchema>;

// =============================================================================
// File Viewer Types
// =============================================================================

export type FileType = 'file' | 'directory' | 'symlink';

export interface FileInfo {
  name: string;
  path: string;
  type: FileType;
  size: number;
  modifiedAt: string;
  isHidden: boolean;
  extension?: string;
}

export interface FileContent {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mimeType: string;
  size: number;
  truncated: boolean;
}

export interface FileChange {
  path: string;
  toolName: 'Write' | 'Edit';
  timestamp: string;
  oldContent?: string;
  newContent?: string;
}

export interface FileListResponse {
  path: string;
  files: FileInfo[];
  parentPath: string | null;
}

export interface FileReadResponse {
  file: FileContent;
}

export interface FileChangesResponse {
  sessionId: string;
  changes: FileChange[];
}

// Git diff types
export type GitChangeStatus = 'M' | 'A' | 'D' | 'R' | '??' | 'U';

export interface GitFileChange {
  path: string;
  status: GitChangeStatus;
  staged: boolean;
}

export interface GitChangesResponse {
  workingDir: string;
  changes: GitFileChange[];
  branch: string;
}

export interface GitDiffResponse {
  diff: string;
  path: string;
}

// =============================================================================
// Dashboard Types
// =============================================================================

export type IndicatorState = 'processing' | 'waiting_input' | 'idle' | 'completed';

export interface LimitRange {
  min: number;
  max: number;
}

export interface CycleLimitInfo {
  used: number;
  limit: LimitRange;
  percentage: number;
  resetTime?: string;
  isStale?: boolean; // Data is older than expected cycle
}

export interface LimitsInfo {
  plan: string;
  cycle5h: CycleLimitInfo;
  weeklyOpus: CycleLimitInfo;
  weeklySonnet: CycleLimitInfo;
}

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ModelUsage {
  model: string;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheRead: number;
  totalCacheWrite: number;
}

// Usage limits from Anthropic API
export interface UsageCycleInfo {
  utilization: number;
  resetsAt: string;
  timeRemaining: string;
  estimatedHitTime?: string; // When limit will be hit at current rate
  status?: 'safe' | 'warning' | 'danger' | 'exceeded'; // Overall status
  statusMessage?: string; // Human-readable prediction message
}

/**
 * A usage limit that applies to a subset of usage rather than the whole plan —
 * currently a single model (e.g. "Fable"). Read from the `limits[]` array of
 * Anthropic's OAuth usage response, where entries with a non-null `scope` are
 * the scoped ones; entries without a scope are the overall cycles already
 * carried by `fiveHour` / `sevenDay`.
 *
 * These matter because the overall cycle can read as comfortable while a
 * scoped limit is already exhausted, which is invisible on a chart that only
 * plots the overall number.
 */
export interface UsageScopedLimit {
  /** `${group}:${name}` — stable identity for history snapshots. */
  key: string;
  /** What the limit is scoped to, e.g. "Fable". */
  name: string;
  /** Which cycle this shares an axis with. */
  group: 'session' | 'weekly';
  utilization: number;
  resetsAt: string;
  /** True when this limit is the one currently constraining usage. */
  isActive: boolean;
  /** Anthropic's own severity verdict, e.g. 'normal' | 'critical'. */
  severity?: string;
}

export interface UsageLimits {
  fiveHour: UsageCycleInfo;
  sevenDay: UsageCycleInfo;
  /** Per-model limits; empty when the API reports none. */
  scopedLimits?: UsageScopedLimit[];
}

// Usage limits derived from Codex rollouts (rate_limits in token_count events).
// Free plan only includes the 7-day window; paid plans may include both.
export interface CodexUsageLimits {
  fiveHour?: UsageCycleInfo;
  sevenDay?: UsageCycleInfo;
  planType?: string;
  capturedAt?: string; // timestamp of the rollout event the limits were read from
  /**
   * True when Codex's most recent rate_limits event reports a non-null
   * `rate_limit_reached_type`. Cycle data may be from an earlier in-cycle
   * measurement when the latest event omits its windows.
   */
  rateLimitExceeded?: boolean;
}

/**
 * Aggregated Grok Build token usage. xAI exposes no rate-limit windows in its
 * local session data (unlike Codex's rate_limits events), so the dashboard
 * shows consumption totals aggregated from `turn_completed` records instead
 * of cycle utilization bars.
 */
export interface GrokUsageWindow {
  /** Completed turns in the window. */
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface GrokUsageSummary {
  last24h: GrokUsageWindow;
  last7d: GrokUsageWindow;
  /** Per-model totals over the 7-day window, largest first. */
  models: Array<{ model: string; totalTokens: number }>;
  /** Sessions active in the 7-day window. */
  sessions7d: number;
  /** 'Free' when the latest turns ran on a `*-free` model id. */
  planType?: string;
  /** ISO timestamp of the most recent turn seen. */
  lastTurnAt?: string;
}

/**
 * Aggregated Kimi Code token usage. Kimi exposes no rate-limit windows or plan
 * data in its local session data, so the dashboard shows consumption totals
 * aggregated from `usage.record` records instead of cycle utilization bars.
 */
export interface KimiUsageWindow {
  /** usage.record entries in the window. */
  turns: number;
  totalTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /**
   * Estimated spend for the window in USD, from local token counts × the
   * provider's list price. Absent when no model in the window could be priced
   * (unknown alias, non-OpenRouter provider, price list unreachable) — an
   * absent cost means "unknown", never "free".
   */
  costUsd?: number;
}

export interface KimiUsageModelTotal {
  /** Model alias as recorded by Kimi (e.g. `k3`). */
  model: string;
  totalTokens: number;
  /** Estimated spend for this model over the 7-day window, USD. */
  costUsd?: number;
  /** Provider-side model id the alias was priced as (e.g. `moonshotai/kimi-k3`). */
  pricedAs?: string;
}

/**
 * One calendar day of Kimi usage, in the server's local time.
 *
 * Local rather than UTC because the question this answers is "what did today
 * cost me" — and a day that ends at 09:00 local is not the day anyone means.
 * The rolling windows above cannot answer it: `last24h` at 10:00 is mostly
 * yesterday.
 */
export interface KimiUsageDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  turns: number;
  totalTokens: number;
  /**
   * Estimated spend for the day, USD. Absent means unknown — a day whose
   * models could not be priced — never "free". A day with no turns at all is
   * genuinely 0.
   */
  costUsd?: number;
  /**
   * False when this server never saw the day at all: it predates the history
   * file, or the machine was down for the whole week the day belonged to.
   * Distinct from an observed day with no usage, and a chart must not draw
   * the two the same way — one is "you spent nothing", the other is "nobody
   * was watching".
   */
  observed: boolean;
}

export interface KimiUsageSummary {
  last24h: KimiUsageWindow;
  last7d: KimiUsageWindow;
  /** Per-model totals over the 7-day window, largest first. */
  models: KimiUsageModelTotal[];
  /**
   * Local calendar days, oldest first, today last. Contiguous — a day with no
   * usage is present with zeroes, because a gap in a bar chart has to be a bar
   * of height zero rather than a missing column.
   *
   * Seven entries on a fresh install, growing daily as completed days are
   * written to the history file, up to a month. Seven is what the log files
   * can still be read for; everything older comes from that file.
   */
  daily: KimiUsageDay[];
  /** Sessions with usage in the 7-day window. */
  sessions7d: number;
  /** ISO timestamp of the most recent usage record seen. */
  lastTurnAt?: string;
}

/**
 * Aggregated OpenCode token usage. Like Grok and Kimi, OpenCode exposes no
 * rate-limit windows locally, so the dashboard shows consumption totals rather
 * than cycle utilization bars.
 *
 * Unlike those two, the cost here is **not** an estimate of ours: OpenCode
 * computes and stores a per-turn `cost` itself, so the figure is whatever it
 * charged the turn at. It is absent, never zeroed, when no turn in the window
 * carried one — and genuinely 0 for free models, which report exactly that.
 */
export interface OpenCodeUsageWindow {
  /** Assistant turns in the window. */
  turns: number;
  totalTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Spend for the window in USD, as recorded by OpenCode. */
  costUsd?: number;
}

export interface OpenCodeUsageSummary {
  last24h: OpenCodeUsageWindow;
  last7d: OpenCodeUsageWindow;
  /** Per-model totals over the 7-day window, largest first. */
  models: Array<{ model: string; totalTokens: number; costUsd?: number }>;
  /** Sessions with turns in the 7-day window. */
  sessions7d: number;
  /** ISO timestamp of the most recent turn seen. */
  lastTurnAt?: string;
}

/**
 * Groq's remaining transcription quota, as reported by `x-ratelimit-*` headers
 * on the last transcription this server made. Not polled - Groq has no usage
 * endpoint, so asking would itself spend a request.
 */
export interface GroqSttRateLimit {
  /** Requests allowed per day, and how many of them are left. */
  limitRequests?: number;
  remainingRequests?: number;
  /** Audio seconds allowed per hour, and how many are left. */
  limitAudioSeconds?: number;
  remainingAudioSeconds?: number;
  /** Time until each bucket is full again, as Groq words it (`1m26.4s`). */
  resetRequests?: string;
  resetAudioSeconds?: string;
  observedAt: string;
}

/**
 * The transcription models Groq offers, verified against its `/models`
 * endpoint on 2026-08-09. Shared so the dashboard and the glasses app offer
 * the same set the server will accept.
 */
export const STT_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'] as const;
export type SttModel = (typeof STT_MODELS)[number];

export interface GroqSttUsageWindow {
  requests: number;
  /** Requests that failed. Counted within `requests`, not on top of it. */
  failures: number;
  audioSeconds: number;
  /**
   * Estimated at the list price per hour of audio, never a billed figure.
   *
   * **Absent when the model in use has no price here** - never zero, which
   * would read as free. Only the model this ran on before the setting existed
   * has a rate written down; inventing one for the other would put a number on
   * the dashboard that nobody checked.
   */
  costUsd?: number;
}

export interface GroqSttUsageDay extends GroqSttUsageWindow {
  date: string; // local YYYY-MM-DD
  /**
   * False when this server was not running for any of the day. Distinct from
   * an observed day with no speech - one is "you said nothing", the other is
   * "nobody was listening".
   */
  observed: boolean;
}

/**
 * Groq speech-to-text consumption by the glasses (`POST /api/glasses/stt`).
 *
 * Recorded as requests happen rather than aggregated from logs: unlike the
 * agents, Groq leaves nothing on this host to re-read afterwards.
 */
export interface GroqSttUsageSummary {
  /** The transcription model these figures were priced and spent against. */
  model: string;
  today: GroqSttUsageWindow;
  last7d: GroqSttUsageWindow;
  /** Local calendar days, oldest first, today last. Contiguous. */
  daily: GroqSttUsageDay[];
  rateLimit?: GroqSttRateLimit;
}

/**
 * Actual OpenRouter spend, read from OpenRouter's own accounting for the API
 * key configured in `~/.kimi-code/config.toml`. Unlike `KimiUsageWindow.costUsd`
 * (a local estimate over rolling windows), these are billed figures over
 * OpenRouter's calendar windows and cover every request made with that key.
 */
export interface OpenRouterAccountUsage {
  /** Key spend in OpenRouter's current day / week / month, USD. */
  usageDailyUsd?: number;
  usageWeeklyUsd?: number;
  usageMonthlyUsd?: number;
  /** All-time spend on this key, USD. */
  usageTotalUsd?: number;
  /** Account-wide credits bought / consumed, USD. */
  creditsPurchasedUsd?: number;
  creditsUsedUsd?: number;
  /** Purchased minus used. Can go negative on a post-paid account. */
  creditsRemainingUsd?: number;
  /** Key spending cap, USD. `null` = no cap set; absent = unknown. */
  limitUsd?: number | null;
  limitRemainingUsd?: number | null;
  fetchedAt: string;
}

// Usage history snapshot for line chart
export interface UsageSnapshot {
  timestamp: string; // ISO 8601
  fiveHour: { utilization: number; resetsAt: string };
  sevenDay: { utilization: number; resetsAt: string };
  /**
   * Per-model utilization keyed by `UsageScopedLimit.key`. Absent on snapshots
   * written before scoped limits were tracked, so readers must treat a missing
   * key as "no sample" rather than 0%.
   */
  scoped?: Record<string, { utilization: number; resetsAt: string }>;
}

export interface UsageHistoryResponse {
  snapshots: UsageSnapshot[];
}

export interface SystemMetricsSnapshot {
  timestamp: number;
  cpuPercent: number;
  memUsedPercent: number;
  memUsedMB: number;
  memTotalMB: number;
  swapUsedMB: number;
  swapTotalMB: number;
}

export interface SystemMetrics {
  current: SystemMetricsSnapshot;
  history: SystemMetricsSnapshot[];
  loadAvg: [number, number, number]; // 1, 5, 15 min
  cpuCount: number;
}

export type UsageLimitsErrorReason =
  | 'no-credentials'
  | 'rate-limited'
  | 'unauthorized'
  | 'fetch-failed'
  | 'unknown';

export interface UsageLimitsStatus {
  errorReason?: UsageLimitsErrorReason;
  rateLimitedUntil?: string; // ISO 8601 — when backoff ends
  lastFetchAt?: string; // ISO 8601 — when the last attempt happened
  isStale?: boolean; // true when serving cached data while backing off
}

/**
 * herdr binary-vs-server version skew. Present only when hrdle could
 * read herdr's status; absent means "don't say anything" (herdr missing or an
 * unreadable status) so a format change never turns into a false warning.
 */
export interface HerdrUpdateStatus {
  /** Version of the herdr binary on disk. */
  binaryVersion?: string;
  /** Version of the herdr server process currently holding the panes. */
  serverVersion?: string;
  /** True when the running server is older than the binary hrdle spawns. */
  restartNeeded: boolean;
  /** True when herdr runs under systemd/launchd, so hrdle can restart it. */
  canApply: boolean;
  /**
   * Newest stable release herdr publishes at `herdr.dev/latest.json`. Absent
   * when the manifest could not be read — comparing versions we don't have
   * would only produce a wrong answer confidently.
   */
  latestVersion?: string;
  /**
   * The published release is newer than the binary on disk. Independent
   * of `restartNeeded`: with binary and server on the same old version there is
   * no skew to see, and this is the only thing that says an update exists.
   */
  updateAvailable?: boolean;
}

/**
 * Whether hrdle itself is current. Reported beside herdr's so the
 * dashboard answers "am I running the current thing?" for both halves of the
 * stack, rather than only warning once something is already inconsistent.
 */
export interface HrdleUpdateStatus {
  /** The running build. */
  currentVersion: string;
  /** Newest published release; absent when GitHub could not be reached. */
  latestVersion?: string;
  /** Absent (never false) when there is no `latestVersion` to compare against. */
  updateAvailable?: boolean;
}

export interface DashboardResponse {
  limits: LimitsInfo | null; // Deprecated, kept for compatibility
  usageLimits: UsageLimits | null; // New: from Anthropic API
  usageLimitsStatus?: UsageLimitsStatus; // Error/state info for UI
  codexUsageLimits?: CodexUsageLimits | null; // From Codex rollouts
  grokUsage?: GrokUsageSummary | null; // From Grok updates.jsonl turn_completed records
  kimiUsage?: KimiUsageSummary | null; // From Kimi wire.jsonl usage.record records
  opencodeUsage?: OpenCodeUsageSummary | null; // From OpenCode's assistant message rows
  // Billed OpenRouter spend for the key in ~/.kimi-code/config.toml. Null when
  // no OpenRouter provider is configured or the account can't be reached.
  openRouterUsage?: OpenRouterAccountUsage | null;
  // Groq speech-to-text spend by the glasses. Null until this server has made
  // a transcription; there is no history to read back from Groq.
  groqSttUsage?: GroqSttUsageSummary | null;
  usageHistory: UsageSnapshot[]; // Usage history for line chart
  dailyActivity: DailyActivity[];
  modelUsage: ModelUsage[];
  hourlyActivity?: Record<number, number>; // Phase 3: Hour (0-23) -> session count
  version?: string; // Hrdle version
  systemMetrics?: SystemMetrics; // System CPU/memory metrics
  diskUsage?: { total: number; used: number; available: number; mountpoint: string };
  connectedClients?: number;
  herdrUpdate?: HerdrUpdateStatus;
  hrdleUpdate?: HrdleUpdateStatus;
  /** When this payload's slow parts were assembled. */
  generatedAt?: string;
  /**
   * The payload was served from cache past its freshness window while a rebuild
   * runs in the background. The client should re-fetch shortly to pick up the
   * refreshed numbers — see `useDashboard`.
   */
  stale?: boolean;
}

export interface ExtendedSessionResponse extends SessionResponse {
  indicatorState?: IndicatorState;
  ccSessionId?: string;
  /**
   * Remote Control bridge session id (`session_…`) read from
   * `~/.claude/sessions/<pid>.json`. Present only while Remote Control is active
   * for this session. The frontend builds `https://claude.ai/code/<id>` from it
   * for the "Open in Claude app" link.
   */
  bridgeSessionId?: string;
  agentSessionId?: string;
  currentCommand?: string;
  ccSummary?: string;
  ccFirstPrompt?: string;
  ccRecap?: string;
  ccRecapAt?: string;
  /**
   * Where `ccRecap` came from, because the two sources are not the same kind
   * of thing and only one of them is worth a strip above the transcript.
   *
   * Claude writes a real away_summary: text that exists nowhere else and says
   * what happened while you were not looking. A thread agent has no such
   * concept, so its recap is a *copy of its latest assistant message* - useful
   * as one line of context on a workspace card, and on the conversation screen
   * the same words as the message directly beneath it.
   *
   * Kimi's was drawn on 79% of that session's conversation frames on
   * 2026-08-08 (Claude's, on the same day: 0%), taking two of the panel's eight
   * lines permanently to repeat what was already on screen.
   *
   * Absent means summary - an older server sending no kind at all is Claude's.
   */
  ccRecapKind?: 'summary' | 'last-message';
  waitingToolName?: string;
  panes?: PaneInfo[];
  /** Tabs of this workspace. Only present when it has more than one tab — a
   *  single-tab workspace renders no tab list. `panes` reflects the active tab. */
  tabs?: TabInfo[];
  activeTabId?: string;
  messageCount?: number;
  gitBranch?: string;
  durationMinutes?: number;
  firstMessageId?: string;
  metrics?: SessionMetrics;
  // Multi-server: which peer owns this session. Set when it comes back from
  // `/api/peers/sessions`; unset in the usual single-peer (local only) setup.
  peerId?: string;
  peerNickname?: string;
  peerColor?: string;
}

// =============================================================================
// Session History Types
// =============================================================================

export interface HistorySession {
  sessionId: string;
  projectPath: string;
  projectName: string;
  /** Historical misnomer: the backend populates this from the LAST user message, not the first. Prefer `lastPrompt` once it is populated (V2). Will be marked `@deprecated` after the frontend reads `lastPrompt` with a `firstPrompt` fallback, and removed after V2 ships. */
  firstPrompt?: string;
  /** The most recent user message in the session, used as the preview when no recap exists. Replaces the misnamed `firstPrompt`. */
  lastPrompt?: string;
  summary?: string;
  /** Latest recap (auto `away_summary` or manual `/recap`), used as the preview when present. Claude-only; codex sessions leave this undefined. */
  recap?: string;
  /** ISO timestamp of the recap that produced `recap`. */
  recapAt?: string;
  modified: string;
  // Phase 2 additions
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
  messageCount?: number;
  gitBranch?: string;
  // For session matching with active sessions
  firstMessageUuid?: string;
  // Which agent produced this history entry. Drives the resume command
  // (`claude -r <id>` vs `codex resume <id>`) and the badge in the UI.
  agent?: AgentProvider;
  // Multi-server: which peer this history belongs to
  peerId?: string;
  peerNickname?: string;
  peerColor?: string;
}

export interface HistorySessionsResponse {
  sessions: HistorySession[];
}

// Multi-server: a history project (one directory under ~/.claude/projects/)
export interface PeerHistoryProject {
  dirName: string;
  projectPath: string;
  projectName: string;
  sessionCount: number;
  latestModified?: string;
  peerId: string;
  peerNickname?: string;
  peerColor?: string;
  /** Reserved for a future cwd-based grouping (resolves the `/` and `.` -> `-` encoding collision). Populated by the backend in a later PR; safe to ignore until then. */
  cwdKey?: string;
}

export interface PeerHistoryProjectsResponse {
  projects: PeerHistoryProject[];
  errors?: { peerId: string; message: string }[];
}

export interface ToolUseInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultImage {
  mediaType: string;
  data: string;
}

export interface ToolResultInfo {
  toolUseId: string;
  toolName?: string;
  output: string;
  images?: ToolResultImage[];
  isError?: boolean;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  thinking?: string;
  toolUse?: ToolUseInfo[];
  toolResult?: ToolResultInfo[];
}

export interface ConversationResponse {
  messages: ConversationMessage[];
}

// =============================================================================
// Terminal Control Types (tmux-convention pane ids / layout rects, herdr-backed)
// =============================================================================

// Layout tree node (tmux rect conventions; produced by herdr-layout.ts)
export interface TmuxLayoutNode {
  type: 'leaf' | 'horizontal' | 'vertical';
  width: number;
  height: number;
  x: number;
  y: number;
  // Leaf only. A number for a numeric pane token (`%3`), the whole `%N` string
  // for anything base36 (`%A`) — see paneWireId in herdr-layout.ts. Read it
  // through paneIdFromLayout rather than interpolating it: `%${paneId}` on a
  // string produces `%%A`.
  paneId?: number | string;
  children?: TmuxLayoutNode[];
}

/** The `%N` pane id of a layout leaf, whichever form it arrived in. */
export function paneIdFromLayout(paneId: number | string | undefined): string {
  return typeof paneId === 'string' ? paneId : `%${paneId ?? 0}`;
}

// -----------------------------------------------------------------------------
// Server-side scrollback (viewport on demand)
//
// herdr is the authoritative store for both the visible region and the
// scrollback. The frontend keeps no buffer of its own; it asks for a
// `viewport` window (offset rows above the live edge) and the server
// answers with the lines herdr currently has for that range.
// -----------------------------------------------------------------------------

export interface PaneCursor {
  x: number;          // 0-based column
  y: number;          // 0-based row within visible area (live mode only)
  visible: boolean;
}

export interface PaneModes {
  altScreen: boolean;      // alternate screen buffer active (vim, htop, etc.)
}

// A client's reported render size for one pane it is currently displaying.
// Part of the per-client sizing model (see `pane-demands`): instead of one
// shared session size + a shared zoom, each client reports the size at which
// it shows each visible pane, and the server reconciles a single PTY size per
// pane. A client that shows only one pane (mobile) reports just that pane.
export interface PaneDemand {
  cols: number;
  rows: number;
}

export interface PaneViewport {
  paneId: string;
  cols: number;            // pane width (cells)
  rows: number;            // pane height (cells)
  lines: string[];         // exactly `rows` entries, top-to-bottom, ANSI-encoded
  cursor: PaneCursor;      // cursor.visible=false when offset>0 (scrolled away)
  modes: PaneModes;
  // Scrollback extent at capture time (capped by herdr's read limit) above the
  // live edge — the frontend uses this to size its ScrollOverlay.
  historySize: number;
  // Echo of the request's offset (0 = live edge, N = N rows scrolled up).
  offset: number;
  atTail: boolean;         // offset === 0
}

// Client → Server messages
export type ControlClientMessage =
  | { type: 'input'; paneId: string; data: string } // base64
  // `active` claims the session size for THIS client (tap-to-resize): the
  // active client owns the shared size, so two devices on one session don't
  // fight over it. Sent on a genuine user tap/focus; automatic (layout-driven)
  // resizes omit it and only take effect if the client is already active.
  | { type: 'resize'; cols: number; rows: number; active?: boolean }
  | { type: 'split'; paneId: string; direction: 'h' | 'v' }
  | { type: 'close-pane'; paneId: string }
  | { type: 'resize-pane'; paneId: string; cols: number; rows: number }
  | { type: 'select-pane'; paneId: string }
  | { type: 'ping'; timestamp: number }
  // `visible` mirrors document.visibilityState. It decides which client owns
  // the glasses focus when several are connected; re-sent on every
  // visibilitychange. Omitted by clients that predate focus follow.
  /**
   * `automated` is `navigator.webdriver`: a browser being driven by software
   * rather than looked at by a person. It exists because the glasses follow the
   * screen someone is holding, and on a machine running several agents the web
   * UI is opened headlessly all day to take screenshots - each one claimed the
   * focus and carried a wearer off mid-conversation.
   */
  // `fresh` marks the first declaration of a page load, as opposed to the same
  // page saying hello again on a new socket. Someone opened this; a reconnect
  // is nobody. Absent from clients too old to send it, which is read as "not
  // fresh": a tab open since before this shipped is exactly the one that must
  // not claim.
  | { type: 'client-info'; deviceType: 'mobile' | 'tablet' | 'desktop'; visible?: boolean; automated?: boolean; fresh?: boolean }
  // Per-client sizing (see `PaneDemand`): the sizes at which THIS client is
  // currently rendering each pane it displays. Keyed by tmux-style `%N`. The
  // server reconciles one PTY size per pane across all clients' demands. A
  // client sends only the panes it shows (mobile: one; desktop: its split
  // rects). Additive to `resize`; ignored unless per-client sizing is enabled.
  | { type: 'pane-demands'; demands: Record<string, PaneDemand> }
  | { type: 'adjust-pane'; paneId: string; direction: 'L' | 'R' | 'U' | 'D'; amount: number }
  // Set the ratios of specific splits in one shot. Each entry identifies a
  // split as the lowest common ancestor of paneA and paneB (expected direction
  // `dir`). Sent when a divider drag ends: boundary-style dragging adjusts the
  // dragged split plus the same-direction splits along the boundary, so the
  // whole consistent set is applied atomically (one relayout).
  | {
      type: 'set-split-ratios';
      entries: Array<{ paneA: string; paneB: string; dir: 'h' | 'v'; ratio: number }>;
    }
  | { type: 'equalize-panes'; direction: 'horizontal' | 'vertical' }
  // Zoom a pane to fill the client area. `zoomed` makes the intent explicit
  // (true = zoom, false = unzoom); when omitted the server toggles (kept for
  // older clients / the glasses app). Mobile always sends an explicit value so
  // that re-issuing zoom on reconnect is idempotent rather than a toggle.
  | { type: 'zoom-pane'; paneId: string; zoomed?: boolean }
  // Ask the server for a viewport `offset` rows above the live edge.
  // offset=0 means live mode; the server will also push fresh viewports
  // unsolicited when new output arrives.
  | { type: 'request-viewport'; paneId: string; offset: number }
  // Tab operations (herdr workspace > tab > pane). Hrdle renders one tab at a
  // time; these switch/create/close the workspace's tabs. `tabId` is a herdr
  // tab id echoed back from `SessionResponse.tabs`.
  | { type: 'select-tab'; tabId: string }
  | { type: 'create-tab' }
  | { type: 'close-tab'; tabId: string };

// Server → Client messages
export type ControlServerMessage =
  // The layout tree is ALWAYS the full split tree, even while a pane is zoomed —
  // zoom is carried separately as `zoomedPaneId` (tmux-style `%N`, or null when
  // nothing is zoomed). This keeps a zoomed session distinguishable from a real
  // single-pane one, so clients (esp. mobile) can render the full pane list /
  // tab bar from server truth instead of guessing.
  | { type: 'layout'; layout: TmuxLayoutNode; zoomedPaneId?: string | null }
  // Viewport payload. Sent in reply to `request-viewport` and pushed
  // unsolicited to live-mode (offset=0) subscribers when the pane emits output.
  | { type: 'viewport'; viewport: PaneViewport }
  | { type: 'ready' }
  | { type: 'pong'; timestamp: number }
  | { type: 'session-exited'; reason: string }
  | { type: 'error'; message: string; paneId?: string }
  // `deliveredToGlasses`: a relay item for this event was created. Informational
  // — nothing suppresses a notification on it any more.
  //
  // It used to, on the reading that the wearer had already been told. It cannot
  // establish that. All it means is that the glasses app held a socket: on
  // 2026-07-31 the G2 returned to its home screen with the app still running
  // and still subscribed, so the flag stayed up while the panel showed nothing,
  // and glasses in a case silenced the phone for as long as the app lived.
  // Neither field that would settle it is usable — `isWearing` reads `false`
  // even on a wearer's face (the protobuf omits zero values), and `connectType`
  // has read `none` on every event recorded.
  //
  // Kept on the wire because it is true and worth seeing, and because this is
  // where suppression goes back when the glasses can say they are worn.
  | { type: 'hook-event'; event: string; cwd?: string; sessionId?: string; message?: string; data?: Record<string, unknown>; deliveredToGlasses?: boolean };

// =============================================================================
// Multiplexed WebSocket Types (single WS per client)
// =============================================================================

/**
 * The three container strings the G2 is showing right now.
 *
 * The glasses app computes these once and hands the same object to the panel
 * and to this channel, so a mirror is not a re-derivation of the screen — it
 * is the screen. Demo viewers render it with the simulator's own painter.
 */
export interface GlassesScreen {
  header: string;
  body: string;
  footer: string;
  /**
   * The glasses build that drew this frame.
   *
   * A recording is read days later to decide whether something is fixed, and
   * without this it cannot answer that: on 2026-08-08 three ehpk builds and
   * three server versions shipped between breakfast and lunch, and telling
   * which one drew a given frame meant correlating the file against a separate
   * console log that happened to print the version. The commit is here for the
   * same reason it is on the setup screen - a version says which number a
   * build claims, not which code it holds.
   *
   * Sent per frame rather than once per connection: it survives a reconnect,
   * an app update mid-recording, and a second device, none of which a
   * remembered value does.
   */
  app?: string;
  appCommit?: string;
  /**
   * Recap / waiting banner, drawn in its own strip above the body with a rule
   * between. Separate from `body` because that rule is a container border on
   * the panel, not a row of text — a mirror that concatenates the two shows a
   * screen the wearer is not looking at.
   */
  notice?: string;
  /**
   * The body is a notification card: inset, bordered, sized to its message,
   * rather than the full-width body every other screen draws. Carried because
   * it is the whole point of that screen — a notice the wearer is meant to
   * read as a notice — and a mirror that drew it flat showed a screen nobody
   * was looking at.
   */
  card?: boolean;
  /**
   * The screen has no header bar and its body owns that band too - the list
   * gives the 36px back to the rows. A mirror that assumes a header draws the
   * whole screen a bar lower than the device does.
   */
  headerless?: boolean;
  /** Which screen this is, for the mirror's status line. */
  mode: string;
  /**
   * The session under the cursor / on screen, as structured data. The header already shows a name, but analysis of a recording
   * should not have to parse display text back apart. Absent on ehpks that
   * predate the field and on screens with no session (empty list, fatal).
   */
  session?: { id: string; name?: string; paneId?: string };
  /** Epoch ms the frame was produced, so a stalled mirror is visible. */
  at: number;
}

/**
 * One ring gesture on the device, named after the controller's own
 * RingAction. Published only while the screen mirror is live, and only ever
 * recorded — a mirror viewer needs the resulting frame, not the finger.
 */
export interface GlassesInput {
  kind: 'tap' | 'doubleTap' | 'swipeUp' | 'swipeDown';
  /** Epoch ms the device handled the gesture. */
  at: number;
}

/**
 * One transcription, as it was actually asked for.
 *
 * Written into the screen recording beside the frame that shows its result,
 * because the recording is the only measurement there is: audio is never
 * stored, so a model or a prompt cannot be compared after the fact by
 * re-running anything - only by reading back what was said and how well it
 * came out. Which left the comparison resting on somebody remembering when
 * the model was switched. Two hours of that memory were already spent once.
 *
 * The Groq key is not here, for the same reason it is not in the preview.
 */
export interface RecordedSttRequest {
  model: string;
  /** `null` when none was sent and Whisper detected it. */
  language: string | null;
  /** The vocabulary prompt as sent, `null` when the bias was off. */
  prompt: string | null;
  promptSource: 'composed' | 'env' | 'off';
  /** The workspace whose words led the prompt, when one was named. */
  sessionId: string | null;
  /** Seconds of audio sent. Short clips are where hallucinations live. */
  audioSeconds: number;
  /** False when the provider did not answer with a transcript. */
  ok: boolean;
  /** What came back, after `stt-corrections`. Absent when the request failed. */
  text?: string;
  /**
   * What came back before corrections, when they changed it.
   *
   * Two different questions are asked of this data - "does this model hear
   * better" and "is the correction table still earning its place" - and the
   * corrected text alone can only answer the first.
   */
  raw?: string;
}

/**
 * One relay item for the G2 glasses channel: a single piece of
 * information the user needs to make a decision, not a summary. `waiting`
 * items are created by the blocked-transition tracker (source 'auto') or by
 * an agent via `hrdle glasses` (source 'agent') and live until the blocked
 * epoch ends or they are dismissed; `info` items are agent self-reports with
 * a TTL, one latest per session.
 */
export interface GlassesRelayItem {
  id: string;
  /** Workspace label of the originating session. */
  sessionId: string;
  /** tmux pane id ("%N") of the blocked pane — reply routing for multi-pane. */
  paneId?: string;
  kind: 'waiting' | 'info';
  /** display-width-clamped text (≈ one G2 page, 189 Japanese chars). */
  text: string;
  /** Scraped or agent-declared choices; the glasses prefer these over a
   *  terminal re-scrape. */
  choices?: string[];
  /**
   * How the pane takes an answer to `choices`.
   *
   * `number` (the default when absent) is claude, codex, kimi and grok: an
   * option is chosen by typing its own number, and the pane's own cursor never
   * has to be moved. `arrow` is opencode, which gives its options no keys at
   * all - answering means walking its cursor along the row and pressing Enter,
   * so the walk needs a starting point and that is `choiceSelected`.
   */
  choiceInput?: 'number' | 'arrow';
  /**
   * Index into `choices` of the option the PANE is currently sitting on.
   *
   * Deliberately not called a cursor: the app has one of those already
   * (`AppState.choiceIndex`), and it is the wearer's - which row the ring is
   * resting on, which is not where the pane is. Answering an `arrow` pane
   * means walking from this index to the wearer's, and confusing the two is
   * exactly how a pick lands on an option nobody chose.
   *
   * Only carried when it was actually measured from the pane. An `arrow` item
   * without it cannot be answered safely, so the app must not offer its
   * choices.
   */
  choiceSelected?: number;
  source: 'auto' | 'agent';
  /**
   * How much of the wearer's attention this is worth — decided here, obeyed
   * there.
   *
   * The app used to decide it, from its own mode: a new `waiting` item took
   * the screen only from the session list, while an `info` item took it from
   * the conversation too. So the thing that needs an answer interrupted less
   * than the thing that only reports one, and on 2026-08-12 a question sat
   * behind a two-line banner for ten minutes while its wearer read the very
   * session that was asking.
   *
   * Fixing that in the app costs an ehpk build and a store review, which is
   * the reason it stayed wrong. The rule is data now: everything about *which*
   * items deserve the screen is computed server-side and travels on the item,
   * and the app is left with the one part only it can know — not to snatch the
   * panel out from under someone mid-utterance or mid-pick.
   *
   * - `takeover` — present it now, whatever is on screen
   * - `takeover-if-elsewhere` — present it unless the wearer already has that
   *   session open (a completion notice thrown over the conversation it
   *   describes says nothing the reader cannot see)
   * - `banner` — the strip and the list carry it; do not interrupt
   *
   * Absent means an app older than this field, which keeps its own rule.
   */
  present?: 'takeover' | 'takeover-if-elsewhere' | 'banner';
  /** Dismissed ("later / on PC") items stay in the store so the same blocked
   *  epoch is not re-synthesized on reconnect, but are excluded from
   *  snapshots. */
  dismissed?: boolean;
  createdAt: number;
  /** info items only. */
  expiresAt?: number;
}

/**
 * Which session the user is currently looking at, so the glasses can follow
 * the device in their hand.
 *
 * Only clients that declared themselves visible via `client-info` are
 * candidates: a phone in a pocket or a sleeping tablet drops out, which is how
 * two devices on one tailnet resolve without a fixed priority. Among visible
 * candidates the last one to open a session wins. When no candidate remains,
 * no focus is reported at all and followers keep whatever they were showing —
 * pocketing a phone must never blank the glasses.
 *
 * Claimed by opening a session (subscribe), not by typing: watching a session
 * scroll by is the common case and produces no input.
 */
export interface ClientFocus {
  sessionId: string;
  deviceType: 'mobile' | 'tablet' | 'desktop';
  /** Epoch ms the focus was claimed — last writer wins among visible clients. */
  at: number;
}

// Client → Server messages for /ws/mux
export type MuxClientMessage =
  /**
   * `resumed` marks a subscription the *socket* asked for, not a person: after
   * a reconnect the client replays whatever it had open. Both look identical
   * on the wire otherwise, and the glasses focus is decided by which screen
   * was most recently brought up - so a tablet left open on a desk kept
   * winning that election every time its WebSocket came back, and carried the
   * wearer off the session they were talking to. Measured on 2026-08-08: 44
   * switches to one session in a day, all from a device nobody had touched.
   */
  | { type: 'subscribe'; sessionId: string; resumed?: boolean }
  | { type: 'unsubscribe'; sessionId: string }
  // `agentSessionId` names the pane's own agent session. Without it the server
  // can only resolve a workspace, and a workspace with two agent panes has two
  // conversations — it answered with whichever pane it happened to summarise
  // the workspace by, which is not the one on screen.
  | { type: 'subscribe-conversation'; sessionId: string; agentSessionId?: string }
  | { type: 'unsubscribe-conversation'; sessionId: string; agentSessionId?: string }
  // Glasses relay presence subscription. No sessionId: it marks the
  // whole connection as "glasses present", which gates relay assembly/send.
  //
  // `onDevice` separates a wearer from a spectator. Both get the items — the
  // simulator's whole job is to show what the panel shows — but only real
  // hardware silences the browser push, because only a wearer is actually
  // being told. Absent means device: an older ehpk that predates the field is
  // running on a face, and a simulator ships with the server that reads this.
  //
  // `instanceId` names which run of the app this is, so the server can retire
  // the previous one. The Even Realities app does not tear down a plugin's old
  // WebView when it launches a new one (everything-evenhub#16, "Ghost WebViews
  // on relaunch": two instances observed running concurrently for 16+ minutes,
  // the stale one still holding the microphone). Nothing on the glasses side can
  // see the other instance — but both of them connect here, so this is the one
  // place that can. Absent means an ehpk older than the field, which is left
  // alone rather than retired on a guess.
  | { type: 'subscribe-glasses-relay'; onDevice?: boolean; instanceId?: string }
  | { type: 'unsubscribe-glasses-relay' }
  // Screen mirroring for demos. The device publishes; browsers subscribe.
  // Only a connection with a real Even Hub bridge publishes, so the simulator
  // never echoes its own frames back at itself.
  | { type: 'glasses-screen'; screen: GlassesScreen }
  | { type: 'subscribe-glasses-screen' }
  | { type: 'unsubscribe-glasses-screen' }
  // A ring gesture, published by the device alongside its screen frames
  //. Recording-only today: the replay player overlays them so demo
  // footage shows the wearer driving, and a debugging trail shows whether the
  // user was mid-interaction right before an app death.
  | { type: 'glasses-input'; input: GlassesInput }
  | (ControlClientMessage & { sessionId: string });

// Runtime validation for client→server /ws/mux frames. The unions above are
// compile-time only; the WS handler receives untrusted JSON and interpolates
// paneId/cols/rows into backend RPC parameters, so every frame is
// validated here before dispatch. Unknown keys are stripped (zod
// default), so forward-compatible clients are unaffected.
const WsPaneDim = z.number().int().min(1).max(2000);
const WsAmount = z.number().int().min(1).max(2000);
const WsOffset = z.number().int().min(0).max(10_000_000);

const controlClientMessageOptions = [
  z.object({ type: z.literal('input'), paneId: PaneIdSchema, data: z.string() }),
  z.object({ type: z.literal('resize'), cols: WsPaneDim, rows: WsPaneDim, active: z.boolean().optional() }),
  z.object({ type: z.literal('split'), paneId: PaneIdSchema, direction: z.enum(['h', 'v']) }),
  z.object({ type: z.literal('close-pane'), paneId: PaneIdSchema }),
  z.object({ type: z.literal('resize-pane'), paneId: PaneIdSchema, cols: WsPaneDim, rows: WsPaneDim }),
  z.object({ type: z.literal('select-pane'), paneId: PaneIdSchema }),
  z.object({ type: z.literal('ping'), timestamp: z.number() }),
  z.object({
    type: z.literal('client-info'),
    deviceType: z.enum(['mobile', 'tablet', 'desktop']),
    visible: z.boolean().optional(),
    automated: z.boolean().optional(),
    fresh: z.boolean().optional(),
  }),
  z.object({ type: z.literal('adjust-pane'), paneId: PaneIdSchema, direction: z.enum(['L', 'R', 'U', 'D']), amount: WsAmount }),
  z.object({
    type: z.literal('set-split-ratios'),
    entries: z
      .array(
        z.object({
          paneA: PaneIdSchema,
          paneB: PaneIdSchema,
          dir: z.enum(['h', 'v']),
          ratio: z.number().gt(0).lt(1),
        }),
      )
      .min(1)
      .max(32),
  }),
  z.object({ type: z.literal('equalize-panes'), direction: z.enum(['horizontal', 'vertical']) }),
  // `zoomed` carries the explicit zoom/unzoom intent; without it here zod
  // strips the field and the server silently falls back to toggle semantics.
  z.object({ type: z.literal('zoom-pane'), paneId: PaneIdSchema, zoomed: z.boolean().optional() }),
  z.object({ type: z.literal('request-viewport'), paneId: PaneIdSchema, offset: WsOffset }),
  z.object({ type: z.literal('select-tab'), tabId: TabIdSchema }),
  z.object({ type: z.literal('create-tab') }),
  z.object({ type: z.literal('close-tab'), tabId: TabIdSchema }),
  z.object({
    type: z.literal('pane-demands'),
    demands: z
      .record(PaneIdSchema, z.object({ cols: WsPaneDim, rows: WsPaneDim }))
      .refine((d) => Object.keys(d).length <= 64, { message: 'too many pane demands' }),
  }),
] as const;

export const MuxClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), sessionId: z.string().min(1), resumed: z.boolean().optional() }),
  z.object({ type: z.literal('unsubscribe'), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal('subscribe-conversation'),
    sessionId: z.string().min(1),
    agentSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('unsubscribe-conversation'),
    sessionId: z.string().min(1),
    agentSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('subscribe-glasses-relay'),
    onDevice: z.boolean().optional(),
    instanceId: z.string().min(1).max(64).optional(),
  }),
  z.object({ type: z.literal('unsubscribe-glasses-relay') }),
  z.object({
    type: z.literal('glasses-screen'),
    screen: z.object({
      // One G2 page each; the caps only keep a rogue client from broadcasting
      // a novel to every viewer.
      header: z.string().max(500),
      body: z.string().max(4000),
      footer: z.string().max(500),
      notice: z.string().max(1000).optional(),
      card: z.boolean().optional(),
      headerless: z.boolean().optional(),
      mode: z.string().max(40),
      session: z
        .object({
          id: z.string().max(200),
          name: z.string().max(500).optional(),
          paneId: z.string().max(50).optional(),
        })
        .optional(),
      at: z.number(),
    }),
  }),
  z.object({ type: z.literal('subscribe-glasses-screen') }),
  z.object({ type: z.literal('unsubscribe-glasses-screen') }),
  z.object({
    type: z.literal('glasses-input'),
    input: z.object({
      kind: z.enum(['tap', 'doubleTap', 'swipeUp', 'swipeDown']),
      at: z.number(),
    }),
  }),
  // Control frames carry a sessionId in the mux protocol (ping may send "").
  ...controlClientMessageOptions.map((o) => o.extend({ sessionId: z.string() })),
]);

// Server → Client messages for /ws/mux
export type MuxServerMessage =
  | { type: 'subscribed'; sessionId: string }
  | { type: 'unsubscribed'; sessionId: string }
  // `focus` rides along so the glasses can follow the phone/tablet in hand
  //; absent when every client is hidden. Ordinary clients ignore it.
  | { type: 'sessions-updated'; sessions: SessionResponse[]; focus?: ClientFocus }
  // Every one echoes the `agentSessionId` it was subscribed with, so a client
  // showing two panes of one workspace can tell whose conversation arrived.
  | { type: 'conversation-subscribed'; sessionId: string; agentSessionId?: string; ccSessionId: string | null }
  | { type: 'conversation-unsubscribed'; sessionId: string; agentSessionId?: string }
  | { type: 'initial-conversation'; sessionId: string; agentSessionId?: string; messages: ConversationMessage[] }
  | { type: 'conversation-update'; sessionId: string; agentSessionId?: string; messages: ConversationMessage[] }
  // Glasses relay. Sent only to connections subscribed via
  // `subscribe-glasses-relay` — never broadcast to ordinary mux clients.
  | { type: 'glasses-relay'; item: GlassesRelayItem } // upsert (create / dismiss reflection)
  | { type: 'glasses-relay-remove'; id: string } // exit-blocked / TTL expiry
  | { type: 'glasses-relay-snapshot'; items: GlassesRelayItem[] } // on subscribe: current blocked set
  // A newer run of the glasses app has arrived; this connection's run is the old
  // one and should let go of everything — panel, microphone, timers, socket.
  // `by` is the newcomer's instanceId, so the log says who retired whom.
  | { type: 'glasses-superseded'; by: string }
  // Screen mirror. `null` means no device is publishing — sent on subscribe
  // when nothing is live, and again when the publisher disconnects, so a demo
  // audience sees "Disconnected" rather than a frozen screen.
  | { type: 'glasses-screen'; screen: GlassesScreen | null }
  // The herdr server is being restarted by this host. Every pane PTY is
  // re-created, so the terminal a client is showing goes stale with no frame to
  // announce it — the page just stops responding and reads as hung. `restored`
  // is the cue to re-subscribe and ask for a fresh viewport rather than waiting
  // for output that will never be prompted.
  | { type: 'herdr-restart'; phase: 'restarting' | 'restored' | 'failed' }
  | (ControlServerMessage & { sessionId: string });
