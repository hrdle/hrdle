import { Hono } from 'hono';
import { z } from 'zod';
import { homedir } from 'node:os';
import { AGENT_PROVIDERS, AGENT_PROVIDER_IDS, CreateSessionSchema, DEFAULT_AGENT_PROVIDER, PaneIdSchema, SessionIdSchema, TabIdSchema, agentResumeCommand, agentSupportsConversationMetadata, isAgentProvider, threadAgentOf, type AgentProvider, type IndicatorState, type PaneInfo, type ExtendedSessionResponse, type SessionState } from '../../../shared/types';
import { HerdrService, findSessionByAddress } from '../services/herdr';
import {
  captureViewportHerdr,
  getOrCreateHerdrControlSession,
  type HerdrControlSession,
} from '../services/herdr-control';
import { ClaudeCodeService } from '../services/claude-code';
import { CodexService } from '../services/codex';
import { CodexConversationService } from '../services/codex-conversation';
import { SessionHistoryService } from '../services/session-history';
import { CodexHistoryService } from '../services/codex-history';
import { GrokService } from '../services/grok';
import { GrokHistoryService } from '../services/grok-history';
import { KimiService } from '../services/kimi';
import { KimiHistoryService } from '../services/kimi-history';
import { OpenCodeService } from '../services/opencode';
import { OpenCodeHistoryService } from '../services/opencode-history';
import type { AgentHistoryProvider, AgentThread, AgentThreadService } from '../services/agent-providers';
import { PromptHistoryService } from '../services/prompt-history';
import { getAllSessionMetadata, setSessionTheme, setSessionSttPrompt, setSessionSttGlossary, addSessionSttTerms, getLastKnownSessions, saveLastKnownSessions, removeLastKnownSession, type LastKnownSession } from '../services/session-metadata';
import { STT_PROMPT_MAX_CHARS, seedWorkspaceVocabulary, sessionPromptTerms } from '../services/stt-prompt';
import { computeSessionMetrics } from '../services/session-metrics';
import { claudeActivity } from '../services/agent-activity';
import { getIndicatorOverride } from './notify';
import { pushSessionsNow } from './terminal-mux';
import { detectPaneState, stripAnsi, type DetectedPaneState } from '../services/pane-state';

const herdrService = new HerdrService();

/** Drop the workspace-list cache so the next buildSessionsList() re-reads herdr.
 *  Called after a mutation (e.g. a tab op) that must reflect in the pushed list
 *  immediately rather than after the 2s cache TTL. */
export function invalidateWorkspacesCache(): void {
  herdrService.invalidateCache();
}

const claudeCodeService = new ClaudeCodeService();
const codexConversationService = new CodexConversationService();
// Exported because peers.ts references it too
export const sessionHistoryService = new SessionHistoryService();

// Thread-based agents (everything except Claude). Adding an agent means adding
// its two service instances here — the routes below iterate these maps.
const threadServices: Partial<Record<AgentProvider, AgentThreadService>> = {
  codex: new CodexService(),
  grok: new GrokService(),
  kimi: new KimiService(),
  opencode: new OpenCodeService(),
};
export const agentHistoryProviders: Partial<Record<AgentProvider, AgentHistoryProvider>> = {
  codex: new CodexHistoryService(undefined, codexConversationService),
  grok: new GrokHistoryService(),
  kimi: new KimiHistoryService(),
  opencode: new OpenCodeHistoryService(),
};
const promptHistoryService = new PromptHistoryService();

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return `${homedir()}${value.slice(1)}`;
  return value;
}

export function agentStartCommand(agent: AgentProvider, workingDir: string): string {
  return `cd ${shellQuote(expandHome(workingDir))} && ${AGENT_PROVIDERS[agent].command}`;
}

export function findDuplicateAgentWorkingDirSession<T extends { agent?: string; currentCommand?: string; currentPath?: string }>(
  sessions: T[],
  agent: AgentProvider,
  workingDir: string,
): T | undefined {
  return sessions.find(s => (s.agent ?? s.currentCommand) === agent && s.currentPath === workingDir);
}

/** Notify mux clients of session changes after mutations */
function notifySessionChange(): void {
  pushSessionsNow();
}

/**
 * Capture a pane viewport for peer-dialog tooling (hrdle send --wait, peek).
 * Returns the trailing `lines` rows (0 = all), with both ANSI-preserved and
 * stripped variants plus a heuristic `detectedState`.
 */
async function captureViewportSnapshot(
  cs: HerdrControlSession,
  paneId: string,
  lines: number,
): Promise<{
  paneId: string;
  cols: number;
  rows: number;
  totalLines: number;
  lines: string[];
  text: string;
  cursor: { x: number; y: number; visible: boolean };
  detectedState: DetectedPaneState;
} | null> {
  const vp = await captureViewportHerdr(cs, paneId, 0);
  if (!vp) return null;
  const slice = lines > 0 ? vp.lines.slice(-lines) : vp.lines;
  const stripped = slice.map(stripAnsi);
  return {
    paneId: vp.paneId,
    cols: vp.cols,
    rows: vp.rows,
    totalLines: vp.lines.length,
    lines: slice,
    text: stripped.join('\n'),
    cursor: vp.cursor,
    detectedState: detectPaneState(vp.lines),
  };
}

/**
 * Run `fn` against the session's control session with REST client
 * accounting: addClient/removeClient bracket the call so a control session
 * created solely for a one-shot REST request (hrdle peek/send, peer calls)
 * starts its grace timer afterwards and gets cleaned up instead of leaking
 * its per-pane controller subprocesses forever.
 */
async function withControlSession<T>(
  sessionId: string,
  fn: (cs: HerdrControlSession) => Promise<T>,
): Promise<T> {
  const cs = await getOrCreateHerdrControlSession(sessionId);
  cs.addClient();
  try {
    return await fn(cs);
  } finally {
    cs.removeClient();
  }
}

/**
 * Deliver text to the session's active pane over the raw control stream.
 * Unlike herdr's pane.send_input RPC (which strips ESC/newlines from text),
 * raw bytes preserve multi-line payloads; `bracketed` wraps the text in
 * bracketed-paste markers so agent TUIs (Claude/Codex) treat embedded
 * newlines as literal lines and the trailing \r as submit.
 */
async function sendTextToSession(
  sessionId: string,
  text: string,
  opts?: { bracketed?: boolean; paneId?: string },
): Promise<string> {
  return withControlSession(sessionId, async (cs) => {
    // Same as raw pane input: an addressed pane may be sitting in another tab,
    // and a reply that cannot land is worse than one that moves the view.
    if (opts?.paneId) await cs.ensurePaneReachable(opts.paneId);
    const panes = await cs.listPanes();
    // An explicit paneId (e.g. a relay item's replyTo pane) wins: in a
    // multi-pane workspace the blocked pane is not necessarily the active one.
    const target = opts?.paneId
      ? panes.find((p) => p.paneId === opts.paneId)
      : panes.find((p) => p.isActive) || panes[0];
    if (!target) throw new Error(opts?.paneId ? 'Pane not found' : 'No pane found');
    const payload = opts?.bracketed ? `\x1b[200~${text}\x1b[201~` : text;
    await cs.sendInput(target.paneId, Buffer.from(payload, 'utf-8'));
    // Deliver the submit \r as its own write, slightly later: agent TUIs
    // can swallow a \r that arrives in the same chunk as the bracketed-paste
    // terminator (treated as part of the paste), leaving the prompt sitting
    // unsubmitted in the input box.
    await new Promise((r) => setTimeout(r, 80));
    await cs.sendInput(target.paneId, Buffer.from('\r', 'utf-8'));
    return target.paneId;
  });
}

/**
 * herdr's agent status → Hrdle indicator.
 *
 * Verified against Claude 2.x on herdr 0.7.3: `working` while responding,
 * `blocked` while a TUI prompt waits on the user (AskUserQuestion and
 * permission prompts both), `idle` before the first turn, `done` after one.
 * Anything else — `unknown`, or a state a future herdr adds — returns null so
 * the caller falls back instead of showing a confidently wrong indicator.
 */
export function herdrStatusToIndicator(status?: string): IndicatorState | null {
  switch (status) {
    case 'working':
      return 'processing';
    case 'blocked':
      return 'waiting_input';
    case 'idle':
    case 'done':
      return 'completed';
    default:
      return null;
  }
}

/**
 * Per-pane indicator: herdr's per-pane status is the source of truth and hook
 * state only fills in what herdr cannot see.
 *
 * A hook override can sit stale for most of a turn — nothing fires between an
 * answered AskUserQuestion and the turn's Stop — so it must never outrank a
 * live herdr status (a stale `waiting_input` becomes a false
 * permission-pending badge on the workspace card).
 *
 * This now holds for thread agents too. They used to keep hooks first because
 * herdr's accuracy for them was unverified, and the cost of that was a
 * Kimi pane frozen at `completed` while it worked: the documented Kimi setup
 * registers `Stop` and nothing else, so the only hook event that ever arrives
 * says "finished" — and it then outranked herdr for the next 24 hours.
 * Verified on herdr 0.7.5: a Kimi pane reported `working` through its turn and
 * `done` the moment it ended. An agent with no herdr integration (Grok) has no
 * status to read, so `herdrStatusToIndicator` returns null and hooks still
 * carry it.
 */
export function paneIndicatorState(opts: {
  paneAgent?: AgentProvider;
  paneAgentStatus?: string;
  sessionIndicator: IndicatorState;
  hookState: IndicatorState | null;
}): IndicatorState {
  if (!opts.paneAgent) return 'idle';
  const herdrState = herdrStatusToIndicator(opts.paneAgentStatus);
  if (agentSupportsConversationMetadata(opts.paneAgent)) {
    return herdrState ?? opts.sessionIndicator;
  }
  return herdrState ?? opts.hookState ?? 'idle';
}

export const sessions = new Hono();

/** Build the full sessions list (shared by HTTP handler and WS push) */
export async function buildSessionsList(): Promise<ExtendedSessionResponse[]> {
  const herdrSessions = await herdrService.listWorkspaces();
  const sessionMetadata = await getAllSessionMetadata();

  // Enrich thread-based agents by the exact native session ids from herdr.
  // A missing integration means no id and therefore no active conversation;
  // never guess from cwd, where multiple sessions are ambiguous.
  const threadsByAgent = new Map<AgentProvider, Map<string, AgentThread>>();
  await Promise.all((Object.entries(threadServices) as [AgentProvider, AgentThreadService][]).map(async ([agentId, service]) => {
    const sessionIds = herdrSessions
      .filter((s): s is typeof s & { agentSessionId: string } =>
        (s.agent ?? s.currentCommand) === agentId && !!s.agentSessionId)
      .map(s => s.agentSessionId);
    if (sessionIds.length === 0) return;
    threadsByAgent.set(agentId, await service.getThreadsByIds(sessionIds));
  }));

  // Remote Control deep-link map: Claude Code sessionId -> bridgeSessionId.
  // Read once per build (cheap: a handful of small ~/.claude/sessions/*.json).
  const bridgeSessionIds = await claudeCodeService.getBridgeSessionIds();

  const results = await Promise.all(herdrSessions.map(async (s) => {
    let ccSession: Awaited<ReturnType<typeof claudeCodeService.getSessionForPath>> | undefined;
    const threadAgent = threadAgentOf(s.agent ?? s.currentCommand);
    const agentThread = threadAgent && s.agentSessionId
      ? threadsByAgent.get(threadAgent)?.get(s.agentSessionId)
      : undefined;

    if (
      agentSupportsConversationMetadata(s.agent ?? s.currentCommand) &&
      s.agentSessionId &&
      s.currentPath
    ) {
      ccSession =
        (await claudeCodeService.getSessionById(s.agentSessionId, s.currentPath)) ??
        undefined;
    }

    const includeClaudeInfo = agentSupportsConversationMetadata(s.agent ?? s.currentCommand);
    const includeThreadInfo = !!threadAgent;
    const conversationSessionId = s.agentSessionId;

    // Indicator state: herdr's own agent detection is the source of truth —
    // it tracks the pane itself, so it can't go stale when a hook is missing,
    // fails to fire, or the agent is killed mid-turn. Hooks only fill in what
    // herdr can't see (an agent it hasn't detected) and carry the notification
    // text / tool name.
    const hookResult = conversationSessionId ? getIndicatorOverride(conversationSessionId) : null;
    const hookState = hookResult?.state ?? null;
    const hookToolName = hookResult?.toolName;
    const herdrState = herdrStatusToIndicator(s.agentStatus);
    const indicatorState: IndicatorState = herdrState ?? hookState ?? 'completed';
    // Only while the pane is actually waiting, and herdr is what says so.
    //
    // The transcript-derived name is whatever tool the record stopped on, and a
    // record mid-turn always stops on one - so `PendingTool` was reported for a
    // session herdr called `working`, continuously. Everything downstream reads
    // this field as "is it waiting" rather than as "what for": the glasses'
    // `isSessionWaiting` did, so a tap on a busy session scraped its pane for
    // options instead of opening the microphone, and offered a wearer two lines
    // of a grep listing as a menu (`71` / `const INFO_TTL_MS = 5 * 60_000;`,
    // measured on the device 2026-08-12).
    //
    // The hook still fills in the name when the transcript has not caught up,
    // which is the case this was written for and the only one it covers now.
    const effectiveWaitingToolName = indicatorState === 'waiting_input'
      ? (ccSession?.waitingToolName ?? hookToolName)
      : undefined;

    let durationMinutes: number | undefined;
    if (ccSession?.modified) {
      const modified = new Date(ccSession.modified);
      durationMinutes = Math.round((Date.now() - modified.getTime()) / 60000);
    }

    // ccSessionId is needed for hook-event matching even when the session was
    // resolved via parent-directory traversal (e.g. a `claude` invocation with
    // no project dir yet). But user-visible content (recap / firstPrompt /
    // summary) must NOT leak from an ancestor project — gate it on
    // ccSession.projectPath === s.currentPath.
    //
    // Unless the id itself matched: an id is unique across every project, so a
    // transcript found by id is this pane's own wherever it turned up. Gating
    // that by path is how a session whose directory was renamed mid-flight lost
    // its recap — the pane's cwd had stopped naming the project it started in.
    const isExactPathMatch =
      !!ccSession &&
      (ccSession.matchedById || (!!s.currentPath && ccSession.projectPath === s.currentPath));

    // Same order for every agent: herdr watches the pane, a hook only reports
    // the moment it fired. Thread agents used to read hooks first, which left a
    // Kimi pane at `completed` for a whole turn — its only registered hook is
    // `Stop`, so "finished" was the only thing hrdle ever heard.
    const sessionIndicatorState = includeClaudeInfo
      ? indicatorState
      : includeThreadInfo
        ? (herdrState ?? hookState ?? undefined)
        : undefined;

    const panePids: (number | undefined)[] = s.panes ? s.panes.map((p: { pid?: number }) => p.pid) : [];
    const metrics = await computeSessionMetrics({
      ccSessionId: includeClaudeInfo ? s.agentSessionId : undefined,
      workingDir: s.currentPath,
      pids: panePids,
    });
    const sessionMetrics = agentThread
      ? {
          ...metrics,
          ...agentThread.tokenUsage,
          totalTokens: agentThread.tokenUsage?.totalTokens ?? agentThread.tokensUsed,
        }
      : metrics;

    // A multi-pane / multi-tab workspace shows per-pane metrics instead of one
    // ambiguous card-header summary; simple single-pane workspaces keep the
    // header summary and skip the extra per-pane metric computation.
    const isMultiWorkspace = (s.panes?.length ?? 0) > 1 || (s.tabs?.length ?? 0) > 1;

    return {
      id: s.id,
      name: s.name,
      instanceId: s.instanceId,
      createdAt: s.createdAt,
      lastAccessedAt: s.createdAt,
      state: (s.attached ? 'working' : 'idle') as SessionState,
      currentCommand: s.currentCommand,
      agent: s.agent,
      currentPath: s.currentPath,
      waitingToolName: includeClaudeInfo ? effectiveWaitingToolName : includeThreadInfo ? hookToolName : undefined,
      ccSummary: includeClaudeInfo ? (isExactPathMatch ? ccSession?.summary : undefined) : agentThread?.title,
      ccFirstPrompt: includeClaudeInfo ? (isExactPathMatch ? ccSession?.firstPrompt : undefined) : agentThread?.firstPrompt,
      ccRecap: includeClaudeInfo && isExactPathMatch ? ccSession?.lastRecap?.content : agentThread?.recap,
      ccRecapAt: includeClaudeInfo && isExactPathMatch ? ccSession?.lastRecap?.timestamp : agentThread?.recapAt,
      // The two branches above are different kinds of text, and this is the
      // only place that knows which one was taken: Claude's is a summary, a
      // thread agent's is a copy of its own latest message (`AgentThread.recap`
      // says so). A reader that cannot tell them apart puts the copy above the
      // message it copies.
      ccRecapKind: (includeClaudeInfo && isExactPathMatch
        ? (ccSession?.lastRecap ? 'summary' : undefined)
        : (agentThread?.recap ? 'last-message' : undefined)) as 'summary' | 'last-message' | undefined,
      indicatorState: sessionIndicatorState,
      // Only while it is working, and only for Claude: this is a tail read of
      // its transcript, and a pane that has stopped has nothing to report.
      activity:
        includeClaudeInfo && sessionIndicatorState === 'processing' && s.agentSessionId
          ? await claudeActivity(s.agentSessionId)
          : undefined,
      ccSessionId: includeClaudeInfo ? s.agentSessionId : undefined,
      bridgeSessionId:
        includeClaudeInfo && s.agentSessionId
          ? bridgeSessionIds.get(s.agentSessionId)
          : undefined,
      agentSessionId: includeThreadInfo ? s.agentSessionId : undefined,
      messageCount: includeClaudeInfo ? ccSession?.messageCount : undefined,
      gitBranch: includeClaudeInfo ? ccSession?.gitBranch : agentThread?.gitBranch,
      durationMinutes: includeClaudeInfo ? durationMinutes : agentThread?.updatedAt ? Math.round((Date.now() - new Date(agentThread.updatedAt).getTime()) / 60000) : undefined,
      firstMessageId: includeClaudeInfo ? ccSession?.firstMessageId : undefined,
      theme: sessionMetadata[s.id]?.theme,
      // No customTitle: the workspace label (= name) is the title. A stored
      // legacy title would only shadow the label the rename now writes to.
      sttPrompt: sessionMetadata[s.id]?.sttPrompt,
      metrics: sessionMetrics,
      panes: s.panes ? await Promise.all(s.panes.map(async (p) => {
        const isSessionAgentOnPane = !!p.agent;
        const paneIndicator = paneIndicatorState({
          paneAgent: p.agent,
          paneAgentStatus: p.agentStatus,
          sessionIndicator: indicatorState,
          hookState,
        });
        // Per-pane metrics + recap only for agent panes of a multi workspace
        // (see isMultiWorkspace); Claude panes get ctx/model/recap from their
        // own .jsonl, any agent pane gets memory from its pid.
        const paneMetrics =
          isMultiWorkspace && isSessionAgentOnPane
            ? await computeSessionMetrics({
                ccSessionId: p.agent === 'claude' ? p.agentSessionId : undefined,
                workingDir: p.path,
                pids: p.pid ? [p.pid] : [],
              })
            : undefined;
        const paneClaude =
          isMultiWorkspace && p.agent === 'claude' && p.agentSessionId && p.path
            ? await claudeCodeService.getSessionById(p.agentSessionId, p.path)
            : null;
        const pane: PaneInfo = {
          paneId: p.paneId,
          currentCommand: p.command,
          currentPath: p.path,
          agent: p.agent,
          agentSessionId: p.agentSessionId,
          isActive: p.isActive,
          tabId: p.tabId,
          label: p.label,
          indicatorState: paneIndicator,
          // What THIS pane is doing, not what the workspace is doing.
          //
          // The session-level field is read from the workspace's primary agent,
          // so in a two-agent workspace both panes reported the same tool call
          // - and the phone's chat, which is per workspace, then had nothing
          // that changed when a pane was picked. Same tail read as the session's
          // and gated the same way: only a pane that is actually processing.
          activity:
            p.agent === 'claude' && p.agentSessionId && paneIndicator === 'processing'
              ? await claudeActivity(p.agentSessionId)
              : undefined,
          pid: p.pid,
          metrics: paneMetrics,
          recap: paneClaude?.lastRecap?.content,
          recapAt: paneClaude?.lastRecap?.timestamp,
        };
        return pane;
      })) : undefined,
      tabs: s.tabs,
      activeTabId: s.activeTabId,
    };
  }));

  // Add lost sessions (existed before reboot but not in herdr now)
  const activeIds = new Set(results.map(s => s.id));
  const activePaths = new Set(results.map(s => s.currentPath).filter(Boolean));
  const lastKnown = await getLastKnownSessions();
  const lostSessions: LastKnownSession[] = [];
  for (const lost of lastKnown) {
    // Skip if session ID still exists or if a new session is already running in the same directory
    if (activeIds.has(lost.id) || (lost.currentPath && activePaths.has(lost.currentPath))) continue;
    lostSessions.push(lost);
    results.push({
      id: lost.id,
      name: lost.name,
      instanceId: undefined,
      createdAt: '',
      lastAccessedAt: '',
      state: 'lost' as SessionState,
      currentCommand: undefined,
      currentPath: lost.currentPath,
      waitingToolName: undefined,
      ccSummary: undefined,
      ccFirstPrompt: undefined,
      ccRecap: undefined,
      ccRecapAt: undefined,
      ccRecapKind: undefined,
      indicatorState: undefined,
      activity: undefined,
      ccSessionId: lost.ccSessionId,
      bridgeSessionId: undefined,
      agentSessionId: lost.agentSessionId,
      messageCount: undefined,
      gitBranch: undefined,
      durationMinutes: undefined,
      firstMessageId: undefined,
      theme: lost.theme,
      // The workspace is gone but its metadata file is not, and a resumed
      // session keeps its id - so the vocabulary it was given survives with it.
      sttPrompt: sessionMetadata[lost.id]?.sttPrompt,
      agent: lost.agent,
      metrics: undefined,
      panes: undefined,
      tabs: undefined,
      activeTabId: undefined,
    });
  }

  // Save snapshot: active sessions + still-lost sessions (so lost ones persist across refreshes).
  // Fall back to previously-known values when herdr did not report a field this round —
  // otherwise a transient gap (e.g. currentPath missing on first capture) erases the data
  // and lost-session resume can't find the project path.
  const prevById = new Map(lastKnown.map(s => [s.id, s]));
  const snapshot: LastKnownSession[] = [
    ...results.filter(s => s.state !== 'lost').map(s => {
      const prev = prevById.get(s.id);
      // currentPath tracks the agent's cwd while an agent runs; once the
      // agent exits, the pane cwd falls back to the shell's dir (often ~)
      // and would DEGRADE the recorded project path, breaking lost-session
      // resume. Keep the last agent-era value in that case.
      const currentPath = s.agent
        ? (s.currentPath ?? prev?.currentPath)
        : (prev?.currentPath ?? s.currentPath);
      return {
        id: s.id,
        name: s.name,
        currentPath,
        agent: s.agent ?? prev?.agent,
        theme: s.theme ?? prev?.theme,
        ccSessionId: s.ccSessionId ?? prev?.ccSessionId,
        agentSessionId: s.agentSessionId ?? prev?.agentSessionId,
      };
    }),
    ...lostSessions,
  ];
  // Fire async, don't block response
  saveLastKnownSessions(snapshot).catch(() => {});

  // No sort: `results` is already in herdr's workspace order (listSessions
  // maps over `workspace.list`), and herdr is the only source of session
  // order. Lost sessions have no workspace, so they trail the live ones.

  return results;
}


const ResumeSessionSchema = z.object({
  ccSessionId: SessionIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
  agent: z.enum(AGENT_PROVIDER_IDS).optional(),
});

// GET /sessions - List all sessions (debug/fallback only, frontend uses WS push)
sessions.get('/', async (c) => {
  const sessionsList = await buildSessionsList();
  return c.json({ sessions: sessionsList });
});

// POST /sessions - Create a new session
sessions.post('/', async (c) => {
  notifySessionChange();
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateSessionSchema.safeParse(body);
  const agent = parsed.success ? parsed.data.agent : DEFAULT_AGENT_PROVIDER;

  // Generate session name
  const herdrSessions = await herdrService.listWorkspaces();
  const name = parsed.success && parsed.data.name
    ? parsed.data.name
    : `session-${herdrSessions.length + 1}`;

  // Check if session already exists
  const exists = await herdrService.workspaceExists(name);
  if (exists) {
    return c.json({ error: 'Session already exists' }, 400);
  }

  // Guard: reject if the same agent is already running in the same directory
  if (parsed.success && parsed.data.workingDir) {
    const conflicting = findDuplicateAgentWorkingDirSession(herdrSessions, agent, parsed.data.workingDir);
    if (conflicting) {
      return c.json({ error: 'duplicate_working_dir', existingSession: conflicting.name }, 409);
    }
  }

  try {
    const instanceId = await herdrService.createWorkspace(name);

    // A new workspace takes a copy of the glossary and stops sharing: from
    // here its vocabulary is one list it owns, and terms it will never say
    // can be deleted. Best-effort - a workspace with no vocabulary of its own
    // falls back to the shared glossary, so failing here costs nothing.
    await seedWorkspaceVocabulary(instanceId ?? name).catch(() => {});

    // Start the selected agent if workingDir is specified
    if (parsed.success && parsed.data.workingDir) {
      await sendTextToSession(name, agentStartCommand(agent, parsed.data.workingDir));

      // Send initial prompt after the agent starts (interactive mode)
      if (parsed.data.initialPrompt) {
        const prompt = parsed.data.initialPrompt;
        const sessionName = name;
        // Poll until the selected agent process is running in the session
        (async () => {
          for (let i = 0; i < 30; i++) { // up to 30 seconds
            await new Promise(r => setTimeout(r, 1000));
            const sessions = await herdrService.listWorkspaces();
            const session = sessions.find(s => s.name === sessionName);
            if (session?.currentCommand === agent) {
              // Wait a bit more for the TUI to be fully ready, then submit
              // via bracketed paste (multi-line prompts stay multi-line).
              await new Promise(r => setTimeout(r, 2000));
              await sendTextToSession(sessionName, prompt, { bracketed: true });
              return;
            }
          }
        })().catch((err) => {
          console.warn(`[sessions] initial prompt delivery failed for ${name}:`, err);
        });
      }
    }

    // The id is herdr's workspace id, the same value the list answers with.
    // Handing back the label instead leaves the caller holding an id that
    // matches nothing in `GET /sessions`, and the frontend persists it into
    // the pane tree — so the desktop comes back from a reload with a session
    // it cannot resolve.
    return c.json({
      id: instanceId,
      name: name,
      instanceId,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      state: 'idle',
      agent,
    }, 201);
  } catch (_error) {
    return c.json({ error: 'Failed to create session' }, 500);
  }
});

// GET /sessions/history/projects - Get list of projects (fast, no file content reading)
// Merges Claude (~/.claude/projects/*) and every thread agent's buckets
// (Codex rollouts, Grok sessions, ...) by encoded cwd so the same directory
// shows up once.
sessions.get('/history/projects', async (c) => {
  const [claudeProjects, ...agentProjects] = await Promise.all([
    sessionHistoryService.getProjects(),
    ...Object.values(agentHistoryProviders).map(p => p.getProjects()),
  ]);
  const byDir = new Map<string, typeof claudeProjects[number]>();
  for (const p of claudeProjects) byDir.set(p.dirName, p);
  for (const p of agentProjects.flat()) {
    const existing = byDir.get(p.dirName);
    if (existing) {
      existing.sessionCount += p.sessionCount;
      if (!existing.latestModified || (p.latestModified && p.latestModified > existing.latestModified)) {
        existing.latestModified = p.latestModified;
      }
    } else {
      byDir.set(p.dirName, p);
    }
  }
  const projects = Array.from(byDir.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
  return c.json({ projects });
});

// GET /sessions/history/search - Search sessions across all projects
sessions.get('/history/search', async (c) => {
  const query = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const [claudeMatches, ...agentMatches] = await Promise.all([
    sessionHistoryService.searchSessions(query, limit),
    ...Object.values(agentHistoryProviders).map(p => p.searchSessions(query, limit)),
  ]);
  const merged = [
    ...claudeMatches.map(s => ({ ...s, agent: s.agent ?? 'claude' as const })),
    ...agentMatches.flat(),
  ].sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()).slice(0, limit);
  return c.json({ sessions: merged });
});

// GET /sessions/history/search/stream - Streaming search with SSE
sessions.get('/history/search/stream', async (c) => {
  const query = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '50', 10);

  // Set up SSE headers
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let yielded = 0;

      try {
        // Emit thread-agent matches up-front (small sets, scanned in one pass).
        const agentMatches = await Promise.all(
          Object.values(agentHistoryProviders).map(p => p.searchSessions(query, limit)),
        );
        for (const session of agentMatches.flat()) {
          if (yielded >= limit) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(session)}\n\n`));
          yielded++;
        }
        // Then stream Claude matches incrementally.
        for await (const session of sessionHistoryService.searchSessionsStream(query, limit - yielded)) {
          if (yielded >= limit) break;
          const tagged = { ...session, agent: session.agent ?? 'claude' as const };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(tagged)}\n\n`));
          yielded++;
        }
        // Send done event
        controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
      } catch (_error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// GET /sessions/history/projects/:dirName - Get sessions for a specific project
// Returns merged Claude + thread-agent sessions in the same project bucket.
sessions.get('/history/projects/:dirName', async (c) => {
  const dirName = c.req.param('dirName');
  const [claudeSessions, ...agentSessions] = await Promise.all([
    sessionHistoryService.getProjectSessions(dirName),
    ...Object.values(agentHistoryProviders).map(p => p.getProjectSessions(dirName)),
  ]);
  const merged = [
    ...claudeSessions.map(s => ({ ...s, agent: s.agent ?? 'claude' as const })),
    ...agentSessions.flat(),
  ].sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return c.json({ sessions: merged });
});

// GET /sessions/history - Get past session history (recent across all projects)
// NOTE: This must be defined BEFORE /:id to prevent "history" being interpreted as an id
sessions.get('/history', async (c) => {
  const includeMetadata = c.req.query('metadata') === 'true';
  const [claudeHistory, ...agentHistory] = await Promise.all([
    sessionHistoryService.getRecentSessions(30, includeMetadata),
    ...Object.values(agentHistoryProviders).map(p => p.getRecentSessions(30)),
  ]);
  const merged = [
    ...claudeHistory.map(s => ({ ...s, agent: s.agent ?? 'claude' as const })),
    ...agentHistory.flat(),
  ].sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()).slice(0, 30);
  return c.json({ sessions: merged });
});

// GET /sessions/history/:sessionId/conversation - Get conversation history for a session
// ?last=N returns only the last N messages (for lightweight clients like G2 glasses)
// ?agent=<provider> routes to that thread agent's reader instead of Claude's jsonl
sessions.get('/history/:sessionId/conversation', async (c) => {
  const sessionId = c.req.param('sessionId');
  const projectDirName = c.req.query('projectDirName');
  const lastQuery = c.req.query('last');
  const last = lastQuery ? parseInt(lastQuery, 10) : undefined;
  const agent = c.req.query('agent');
  const provider = agent && isAgentProvider(agent) ? agentHistoryProviders[agent] : undefined;
  const messages = provider
    ? await provider.getConversation(sessionId)
    : await sessionHistoryService.getConversation(sessionId, projectDirName);
  return c.json({ messages: last ? messages.slice(-last) : messages });
});

// POST /sessions/history/metadata - Lazy load metadata for specific sessions
const MetadataRequestSchema = z.object({
  sessionIds: z.array(z.string()),
});

sessions.post('/history/metadata', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = MetadataRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request: sessionIds array required' }, 400);
  }

  const { sessionIds } = parsed.data;
  const metadata = await sessionHistoryService.getSessionsMetadata(sessionIds);
  return c.json({ metadata });
});

// GET /sessions/prompts/search - Search prompt history (C1)
sessions.get('/prompts/search', async (c) => {
  const query = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '20', 10);

  if (!query.trim()) {
    // Return recent prompts if no query
    const prompts = await promptHistoryService.getRecentPrompts(limit);
    return c.json({ prompts });
  }

  const prompts = await promptHistoryService.searchPrompts(query, limit);
  return c.json({ prompts });
});

// POST /sessions/history/resume - Resume a session from history (creates a new session)
// NOTE: Must be defined BEFORE /:id routes
const ResumeHistorySchema = z.object({
  sessionId: SessionIdSchema,
  projectPath: z.string(),
  agent: z.enum(AGENT_PROVIDER_IDS).optional(),
});

sessions.post('/history/resume', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = ResumeHistorySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request: sessionId and projectPath required' }, 400);
  }

  const { sessionId } = parsed.data;
  const agent: AgentProvider = parsed.data.agent ?? DEFAULT_AGENT_PROVIDER;
  // The provided projectPath can be stale (lost sessions record the pane's
  // cwd, which falls back to the shell dir once the agent exits). The cwd
  // recorded inside the conversation .jsonl is authoritative — `claude -r`
  // only finds conversations from the project directory they belong to.
  const recordedCwd =
    agent === 'claude' ? await claudeCodeService.resolveSessionCwd(sessionId) : null;
  const projectPath = recordedCwd ?? parsed.data.projectPath;

  try {
    // Generate a unique session name based on project
    const projectName = projectPath.split('/').pop() || 'session';
    const herdrSessions = await herdrService.listWorkspaces();

    // Guard: reject if the same agent is already running in the same directory
    const conflicting = findDuplicateAgentWorkingDirSession(herdrSessions, agent, projectPath);
    if (conflicting) {
      return c.json({ error: 'duplicate_working_dir', existingSession: conflicting.name }, 409);
    }
    let sessionName = projectName;
    let counter = 1;
    while (herdrSessions.some(s => s.name === sessionName)) {
      sessionName = `${projectName}-${counter++}`;
    }

    // Create new session
    await herdrService.createWorkspace(sessionName);

    // Change to project directory and run the agent's resume command
    const command = `cd ${shellQuote(expandHome(projectPath))} && ${agentResumeCommand(agent, sessionId)}`;
    try {
      await sendTextToSession(sessionName, command);
    } catch {
      // Clean up the session if command failed
      await herdrService.killWorkspace(sessionName);
      return c.json({ error: 'Failed to start agent session' }, 500);
    }

    return c.json({
      success: true,
      tmuxSessionId: sessionName,
      ccSessionId: sessionId,
      agent,
    });
  } catch (_error) {
    return c.json({ error: 'Failed to resume session from history' }, 500);
  }
});

// GET /sessions/:id - Get a specific session
sessions.get('/:id', async (c) => {
  const id = c.req.param('id');
  const herdrSessions = await herdrService.listWorkspaces();
  // By id, then by name - the same two ways every other route accepts, and
  // for the same reason: a name is what a person types and what an
  // older client still holds. An ambiguous name resolves to nothing rather
  // than to whichever workspace happens to sort first.
  const { session, ambiguous } = findSessionByAddress(herdrSessions, id);

  if (!session) {
    return c.json({ error: ambiguous ? 'Ambiguous session name' : 'Session not found' }, 404);
  }

  return c.json({
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    lastAccessedAt: session.createdAt,
    state: session.attached ? 'working' : 'idle',
    currentCommand: session.currentCommand,
    agent: session.agent,
    currentPath: session.currentPath,
  });
});

// DELETE /sessions/:id - Delete (kill) a session
sessions.delete('/:id', async (c) => {
  notifySessionChange();
  const id = c.req.param('id');

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    // Already lost — purge from last-known so it disappears from the list.
    await removeLastKnownSession(id).catch(() => {});
    return c.json({ success: true });
  }

  try {
    await herdrService.killWorkspace(id);
    // Keep the entry in last-known so the session shows up as "Lost" and can
    // be resumed via the Resume button without going to the history tab.
    // To purge entirely, delete the Lost session again.
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to delete session' }, 500);
  }
});

// POST /sessions/:id/resume - Resume an agent session in an existing session
sessions.post('/:id/resume', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = ResumeSessionSchema.safeParse(body);

  const herdrSessions = await herdrService.listWorkspaces();
  const { session, ambiguous } = findSessionByAddress(herdrSessions, id);
  if (!session) {
    return c.json({ error: ambiguous ? 'Ambiguous session name' : 'Session not found' }, 404);
  }

  try {
    const sessionId = parsed.success ? (parsed.data.sessionId ?? parsed.data.ccSessionId) : undefined;
    const requestedAgent = parsed.success ? parsed.data.agent : undefined;
    const agent: AgentProvider = requestedAgent ?? session.agent ?? DEFAULT_AGENT_PROVIDER;
    const command = agentResumeCommand(agent, sessionId);

    await sendTextToSession(id, command);

    return c.json({ success: true, command });
  } catch (_error) {
    return c.json({ error: 'Failed to resume session' }, 500);
  }
});

// PUT /sessions/:id/theme - Update session theme color
const UpdateThemeSchema = z.object({
  theme: z.enum(['red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink']).nullable(),
});

sessions.put('/:id/theme', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateThemeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid theme' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    await setSessionTheme(id, parsed.data.theme);
    return c.json({ success: true, theme: parsed.data.theme });
  } catch (_error) {
    return c.json({ error: 'Failed to update theme' }, 500);
  }
});

// PUT /sessions/:id/title - Rename the session's herdr workspace. The name
// lives in herdr (workspace label), not in an hrdle-side store — same rule as
// the display order. The label is *not* the session id, so a rename
// changes what it is called and nothing about how it is reached.
const UpdateTitleSchema = z.object({
  title: z.string().max(100).nullable(),
});

sessions.put('/:id/title', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateTitleSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid title' }, 400);
  }
  const title = parsed.data.title?.trim();
  if (!title) {
    return c.json({ error: 'Title must not be empty' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    // The id does not change with the name, so nothing is rekeyed and
    // nothing has to switch addresses, which is the whole point: a rename
    // must not retire the session's address mid-conversation.
    const sessionId = await herdrService.renameWorkspace(id, title);
    return c.json({ success: true, title, id: sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('already exists')) {
      return c.json({ error: 'A session with that name already exists' }, 409);
    }
    return c.json({ error: 'Failed to update title' }, 500);
  }
});

// PUT /sessions/:id/stt-prompt - Words this session's speech is made of.
//
// Kept short deliberately: Whisper's prompt is capped at 224 tokens and this
// group leads the composition, so a long one would push out the glossary it is
// meant to sit in front of. 100 rather than the 200 it started at, because the
// composition now hard-limits the contributed groups to half its budget
// and a field that accepts twice what can be used is a field that silently
// drops the rest.
// The cap is the whole prompt line, not half of it: a workspace that has
// declined the glossary has the whole budget, and a stored value cut shorter
// than what composition would take is a second, invisible limit.
const UpdateSttPromptSchema = z.object({
  sttPrompt: z.string().max(STT_PROMPT_MAX_CHARS).nullable().optional(),
  /** Add to what is there instead of replacing it. */
  add: z.string().max(STT_PROMPT_MAX_CHARS).optional(),
  glossary: z.boolean().optional(),
});

sessions.put('/:id/stt-prompt', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateSttPromptSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid STT prompt' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    if (parsed.data.sttPrompt !== undefined) {
      await setSessionSttPrompt(id, parsed.data.sttPrompt);
    }
    if (parsed.data.glossary !== undefined) {
      await setSessionSttGlossary(id, parsed.data.glossary);
    }
    if (parsed.data.add !== undefined) {
      const result = await addSessionSttTerms(
        id,
        sessionPromptTerms(parsed.data.add),
        STT_PROMPT_MAX_CHARS,
      );
      if (!result.ok) {
        return c.json(
          { error: 'too_long', wouldBe: result.wouldBe, max: STT_PROMPT_MAX_CHARS, sttPrompt: result.stored },
          400,
        );
      }
      return c.json({ success: true, sttPrompt: result.stored, added: result.added, duplicate: result.duplicate });
    }
    return c.json({ success: true, sttPrompt: parsed.data.sttPrompt });
  } catch (_error) {
    return c.json({ error: 'Failed to update STT prompt' }, 500);
  }
});

// POST /sessions/:id/move - Move a session to `index` in the display order.
// The order lives in herdr (workspace order), not in hrdle — so this is a
// write straight through to herdr rather than to a hrdle-side store.
sessions.post('/:id/move', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const index = (body as { index?: unknown }).index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    return c.json({ error: 'Invalid index' }, 400);
  }
  try {
    const moved = await herdrService.moveWorkspace(id, index);
    if (!moved) return c.json({ error: 'Session not found' }, 404);
    notifySessionChange();
    return c.json({ success: true });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Failed to move session' },
      500,
    );
  }
});

// =============================================================================
// Pane Operations
// =============================================================================

const PaneFocusSchema = z.object({
  paneId: PaneIdSchema,
});

const PaneCloseSchema = z.object({
  paneId: PaneIdSchema,
});

const PaneSplitSchema = z.object({
  paneId: PaneIdSchema,
  direction: z.enum(['h', 'v']),
});

const TabSelectSchema = z.object({
  tabId: TabIdSchema,
});

const TabCloseSchema = z.object({
  tabId: TabIdSchema,
});

const PaneInputSchema = z.object({
  paneId: PaneIdSchema,
  data: z.string(),
  encoding: z.enum(['utf-8', 'base64']).optional().default('utf-8'),
  // peer-dialog helpers: if `wait` is true the response includes a viewport
  // snapshot captured `waitMs` after the input is delivered. `lines` is how
  // many trailing rows to return (0 = all). Defaults match the CLI defaults.
  wait: z.boolean().optional().default(false),
  waitMs: z.number().int().min(0).max(10000).optional().default(800),
  lines: z.number().int().min(0).max(500).optional().default(20),
});

// POST /sessions/:id/panes/focus - Focus a specific pane
sessions.post('/:id/panes/focus', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = PaneFocusSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    await withControlSession(id, (cs) => cs.selectPane(parsed.data.paneId));
    herdrService.invalidateCache();
    notifySessionChange();
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to focus pane' }, 500);
  }
});

// POST /sessions/:id/panes/close - Close a specific pane
sessions.post('/:id/panes/close', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = PaneCloseSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    // rejects the last pane itself
    await withControlSession(id, (cs) => cs.closePane(parsed.data.paneId));
    herdrService.invalidateCache();
    notifySessionChange();
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to close pane';
    const status = message.includes('last pane') ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

// POST /sessions/:id/panes/split - Split a pane
sessions.post('/:id/panes/split', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = PaneSplitSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    await withControlSession(id, (cs) => cs.splitPane(parsed.data.paneId, parsed.data.direction));
    herdrService.invalidateCache();
    notifySessionChange();
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to split pane' }, 500);
  }
});

// POST /sessions/:id/tabs/select - Switch the workspace's active tab
sessions.post('/:id/tabs/select', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = TabSelectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid tab ID' }, 400);
  }
  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }
  try {
    await withControlSession(id, (cs) => cs.selectTab(parsed.data.tabId));
    herdrService.invalidateCache();
    notifySessionChange();
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to select tab' }, 500);
  }
});

// POST /sessions/:id/tabs/create - Create and switch to a new tab
sessions.post('/:id/tabs/create', async (c) => {
  const id = c.req.param('id');
  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }
  try {
    await withControlSession(id, (cs) => cs.createTab());
    herdrService.invalidateCache();
    notifySessionChange();
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to create tab' }, 500);
  }
});

// POST /sessions/:id/tabs/close - Close a tab (and its panes)
sessions.post('/:id/tabs/close', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = TabCloseSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid tab ID' }, 400);
  }
  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }
  try {
    await withControlSession(id, (cs) => cs.closeTab(parsed.data.tabId));
    herdrService.invalidateCache();
    notifySessionChange();
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to close tab' }, 500);
  }
});

// POST /sessions/:id/panes/input - Send raw input bytes to a specific pane
sessions.post('/:id/panes/input', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = PaneInputSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  // Same as /prompt: this delivers keystrokes, so an ambiguous name says so.
  const status = await herdrService.addressStatus(id);
  if (status !== 'ok') {
    return c.json(
      status === 'ambiguous'
        ? { error: `"${id}" names more than one session - address it by session id` }
        : { error: 'Session not found' },
      404,
    );
  }

  try {
    return await withControlSession(id, async (controlSession) => {
      // A pane in another tab is still a live agent; bring it into view rather
      // than refusing to answer it.
      await controlSession.ensurePaneReachable(parsed.data.paneId);
      const panes = await controlSession.listPanes();
      const targetPane = panes.find((p) => p.paneId === parsed.data.paneId);
      if (!targetPane) {
        return c.json({ error: 'Pane not found' }, 404);
      }

      const buffer = parsed.data.encoding === 'base64'
        ? Buffer.from(parsed.data.data, 'base64')
        : Buffer.from(parsed.data.data, 'utf-8');
      await controlSession.sendInput(parsed.data.paneId, buffer);

      if (!parsed.data.wait) {
        return c.json({ success: true, paneId: parsed.data.paneId, bytes: buffer.length });
      }

      // Give the TUI time to render before snapshotting.
      if (parsed.data.waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, parsed.data.waitMs));
      }
      const viewport = await captureViewportSnapshot(controlSession, parsed.data.paneId, parsed.data.lines);
      return c.json({
        success: true,
        paneId: parsed.data.paneId,
        bytes: buffer.length,
        viewport,
      });
    });
  } catch (_error) {
    return c.json({ error: 'Failed to send input' }, 500);
  }
});

// GET /sessions/:id/panes/:paneId/viewport - Snapshot a pane's current viewport
sessions.get('/:id/panes/:paneId/viewport', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const linesParam = c.req.query('lines');
  const lines = linesParam ? Math.max(0, Math.min(500, Number.parseInt(linesParam, 10) || 0)) : 20;

  if (!paneId.startsWith('%')) {
    return c.json({ error: 'paneId must start with %' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    return await withControlSession(id, async (controlSession) => {
      const panes = await controlSession.listPanes();
      if (!panes.find((p) => p.paneId === paneId)) {
        return c.json({ error: 'Pane not found' }, 404);
      }
      const viewport = await captureViewportSnapshot(controlSession, paneId, lines);
      if (!viewport) {
        return c.json({ error: 'Failed to capture viewport' }, 500);
      }
      return c.json(viewport);
    });
  } catch (_error) {
    return c.json({ error: 'Failed to capture viewport' }, 500);
  }
});

// POST /sessions/:id/prompt - Send a prompt text to the session's active pane.
// Optional `paneId` targets a specific pane (glasses relay reply routing):
// in a multi-pane workspace the blocked pane is not necessarily the active one.
sessions.post('/:id/prompt', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const text = body.text as string | undefined;
  const paneId = body.paneId as string | undefined;

  if (!text) {
    return c.json({ error: 'text is required' }, 400);
  }
  if (paneId !== undefined) {
    const parsed = PaneIdSchema.safeParse(paneId);
    if (!parsed.success) {
      return c.json({ error: 'Invalid pane ID' }, 400);
    }
  }

  // The delivery paths say *why* nothing was reached: a name that now points at
  // two workspaces has to be answered differently from one that points at none
  //, because only one of them is fixed by saying which session.
  const status = await herdrService.addressStatus(id);
  if (status !== 'ok') {
    return c.json(
      status === 'ambiguous'
        ? { error: `"${id}" names more than one session - address it by session id` }
        : { error: 'Session not found' },
      404,
    );
  }

  try {
    // Bracketed paste + separately-delivered \r (see sendTextToSession)
    const targetPaneId = await sendTextToSession(id, text, { bracketed: true, paneId });
    return c.json({ success: true, paneId: targetPaneId });
  } catch (error) {
    if (error instanceof Error && error.message === 'Pane not found') {
      return c.json({ error: 'Pane not found' }, 404);
    }
    return c.json({ error: 'Failed to send prompt' }, 500);
  }
});
