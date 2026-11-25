import { ClaudeBackgroundReader } from './claude-footer';
import { readPaneText, toHerdrPaneId } from './herdr-client';
import { paneStatusClock } from './pane-status-since';
import { agentSupportsConversationMetadata, threadAgentOf, type AgentProvider, type IndicatorState, type PaneInfo, type ExtendedSessionResponse, type SessionState } from '../../../shared/types';
import { HerdrService } from './herdr';
import { ClaudeCodeService } from './claude-code';
import { CodexService } from './codex';
import { GrokService } from './grok';
import { KimiService } from './kimi';
import { OpenCodeService } from './opencode';
import { PiService } from './pi';
import { piTurnWatcher } from './pi-turn-notify';
import { threadSessionIdsOf, withThreadUsage, type AgentThread, type AgentThreadService } from './agent-providers';
import { getAllSessionMetadata, getLastKnownSessions, saveLastKnownSessions, type LastKnownSession } from './session-metadata';
import { computeSessionMetrics } from './session-metrics';
import { claudeActivity } from './agent-activity';
import { getIndicatorOverride } from '../routes/notify';

export const herdrService = new HerdrService();

/** Drop the workspace-list cache so the next buildSessionsList() re-reads herdr.
 *  Called after a mutation (e.g. a tab op) that must reflect in the pushed list
 *  immediately rather than after the 2s cache TTL. */
export function invalidateWorkspacesCache(): void {
  herdrService.invalidateCache();
}

export const claudeCodeService = new ClaudeCodeService();
// Thread-based agents (everything except Claude). Adding an agent means one
// instance here and its history provider in `routes/session-history.ts`; the
// list and the routes iterate these maps.
const threadServices: Partial<Record<AgentProvider, AgentThreadService>> = {
  codex: new CodexService(),
  grok: new GrokService(),
  kimi: new KimiService(),
  opencode: new OpenCodeService(),
  pi: new PiService(),
};
/**
 * Whether a session remembered from before a restart is still running.
 *
 * Its workspace being here settles it, and so does its conversation running
 * in any pane. The directory decides only for a session that never had a
 * conversation id: one directory holds several sessions, so another one open
 * there says nothing about this one.
 */
export function liveSessionMatcher(
  live: Array<{ id: string; currentPath?: string; agentSessionId?: string; panes?: Array<{ agentSessionId?: string }> }>,
): (lost: { id: string; currentPath?: string; agentSessionId?: string }) => boolean {
  const ids = new Set(live.map((s) => s.id));
  const paths = new Set(live.map((s) => s.currentPath).filter(Boolean));
  const conversations = new Set(
    live.flatMap((s) => [s.agentSessionId, ...(s.panes ?? []).map((p) => p.agentSessionId)]).filter(Boolean),
  );
  return (lost) => {
    if (ids.has(lost.id)) return true;
    if (lost.agentSessionId) return conversations.has(lost.agentSessionId);
    return !!lost.currentPath && paths.has(lost.currentPath);
  };
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
 * The workspace-level indicator: herdr's status first, then the hook. Absent
 * for a workspace with no agent, which has nothing to indicate.
 */
export function sessionIndicatorOf(
  agent: string | undefined,
  agentStatus: string | undefined,
  hookState: IndicatorState | null,
): IndicatorState | undefined {
  const herdrState = herdrStatusToIndicator(agentStatus);
  if (agentSupportsConversationMetadata(agent)) return herdrState ?? hookState ?? 'completed';
  if (threadAgentOf(agent)) return herdrState ?? hookState ?? undefined;
  return undefined;
}

/**
 * The session's `state`, read from the same indicator the cards show.
 *
 * A delegating agent polls this field to learn whether the work it handed off
 * is finished, so it has to follow the agent rather than the terminal. A
 * finished turn is `idle`: whether anyone has looked at it yet is `unseen`.
 */
export function sessionStateOf(indicator?: IndicatorState): SessionState {
  switch (indicator) {
    case 'processing':
      return 'working';
    case 'waiting_input':
      return 'waiting_input';
    default:
      return 'idle';
  }
}

/** `true` or absent, so a seen pane adds nothing to the payload. */
export function isUnseen(status?: string): true | undefined {
  return status === 'done' ? true : undefined;
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

const claudeBackground = new ClaudeBackgroundReader((id) => readPaneText(id, 'visible'));

/** The full sessions list, shared by the HTTP handler and the WS push. */
export async function buildSessionsList(): Promise<ExtendedSessionResponse[]> {
  const herdrSessions = await herdrService.listWorkspaces();
  // pi has no hook to announce a finished turn; its live session files are watched instead.
  void piTurnWatcher.track(
    herdrSessions
      .filter((s): s is typeof s & { agentSessionId: string } => (s.agent ?? s.currentCommand) === 'pi' && !!s.agentSessionId)
      .map((s) => ({ sessionId: s.agentSessionId, cwd: s.currentPath })),
  );
  const sessionMetadata = await getAllSessionMetadata();

  // Enrich thread-based agents by the exact native session ids from herdr.
  // A missing integration means no id and therefore no active conversation;
  // never guess from cwd, where multiple sessions are ambiguous.
  const threadsByAgent = new Map<AgentProvider, Map<string, AgentThread>>();
  await Promise.all((Object.entries(threadServices) as [AgentProvider, AgentThreadService][]).map(async ([agentId, service]) => {
    const sessionIds = threadSessionIdsOf(agentId, herdrSessions);
    if (sessionIds.length === 0) return;
    threadsByAgent.set(agentId, await service.getThreadsByIds(sessionIds));
  }));

  // Remote Control deep-link map: Claude Code sessionId -> bridgeSessionId.
  // Read once per build (cheap: a handful of small ~/.claude/sessions/*.json).
  const bridgeSessionIds = await claudeCodeService.getBridgeSessionIds();

  const now = Date.now();
  const livePaneKeys = new Set<string>();
  const liveClaudePanes = new Set<string>();
  const results = await Promise.all(herdrSessions.map(async (s) => {
    let ccSession: Awaited<ReturnType<typeof claudeCodeService.getSessionById>> | undefined;
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
    const indicatorState: IndicatorState = herdrStatusToIndicator(s.agentStatus) ?? hookState ?? 'completed';
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

    // Same order for every agent: herdr watches the pane, a hook only reports
    // the moment it fired. Thread agents used to read hooks first, which left a
    // Kimi pane at `completed` for a whole turn — its only registered hook is
    // `Stop`, so "finished" was the only thing hrdle ever heard.
    const sessionIndicatorState = sessionIndicatorOf(s.agent ?? s.currentCommand, s.agentStatus, hookState);

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
      state: sessionStateOf(sessionIndicatorState),
      currentCommand: s.currentCommand,
      agent: s.agent,
      currentPath: s.currentPath,
      waitingToolName: includeClaudeInfo ? effectiveWaitingToolName : includeThreadInfo ? hookToolName : undefined,
      ccSummary: includeClaudeInfo ? ccSession?.summary : agentThread?.title,
      ccFirstPrompt: includeClaudeInfo ? ccSession?.firstPrompt : agentThread?.firstPrompt,
      ccRecap: includeClaudeInfo ? ccSession?.lastRecap?.content : agentThread?.recap,
      ccRecapAt: includeClaudeInfo ? ccSession?.lastRecap?.timestamp : agentThread?.recapAt,
      // The two branches above are different kinds of text, and this is the
      // only place that knows which one was taken: Claude's is a summary, a
      // thread agent's is a copy of its own latest message (`AgentThread.recap`
      // says so). A reader that cannot tell them apart puts the copy above the
      // message it copies.
      ccRecapKind: (includeClaudeInfo
        ? (ccSession?.lastRecap ? 'summary' : undefined)
        : (agentThread?.recap ? 'last-message' : undefined)) as 'summary' | 'last-message' | undefined,
      indicatorState: sessionIndicatorState,
      unseen: s.panes ? s.panes.some((p) => isUnseen(p.agentStatus)) || undefined : isUnseen(s.agentStatus),
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
        const paneThreadAgent = isMultiWorkspace ? threadAgentOf(p.agent) : undefined;
        const paneThread = paneThreadAgent && p.agentSessionId
          ? threadsByAgent.get(paneThreadAgent)?.get(p.agentSessionId)
          : undefined;
        const paneMetrics =
          isMultiWorkspace && isSessionAgentOnPane
            ? withThreadUsage(await computeSessionMetrics({
                ccSessionId: p.agent === 'claude' ? p.agentSessionId : undefined,
                workingDir: p.path,
                pids: p.pid ? [p.pid] : [],
              }), paneThread)
            : undefined;
        const paneClaude =
          isMultiWorkspace && p.agent === 'claude' && p.agentSessionId && p.path
            ? await claudeCodeService.getSessionById(p.agentSessionId, p.path)
            : null;
        const herdrPaneId = toHerdrPaneId(s.id, p.paneId);
        livePaneKeys.add(herdrPaneId);
        const witnessed = p.agent ? paneStatusClock.observe(herdrPaneId, p.agentStatus, now) : null;
        // Finished before this server was watching: the transcript's last
        // write is when it stopped. No such stand-in exists for a pane still
        // working, whose transcript is being written right now.
        const finished = p.agentStatus === 'idle' || p.agentStatus === 'done';
        const lastWrite = isMultiWorkspace
          ? (paneClaude?.modified ?? paneThread?.updatedAt)
          : (ccSession?.modified ?? agentThread?.updatedAt);
        const statusSince = witnessed !== null
          ? new Date(witnessed).toISOString()
          : (p.agent && finished ? lastWrite : undefined);
        const background = p.agent === 'claude' ? claudeBackground.get(herdrPaneId, now) : [];
        if (p.agent === 'claude') liveClaudePanes.add(herdrPaneId);
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
          unseen: isUnseen(p.agentStatus),
          statusSince,
          background: background.length > 0 ? background : undefined,
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
          bridgeSessionId:
            p.agent === 'claude' && p.agentSessionId
              ? bridgeSessionIds.get(p.agentSessionId)
              : undefined,
          pid: p.pid,
          metrics: paneMetrics,
          recap: paneClaude?.lastRecap?.content ?? paneThread?.recap,
          recapAt: paneClaude?.lastRecap?.timestamp ?? paneThread?.recapAt,
        };
        return pane;
      })) : undefined,
      tabs: s.tabs,
      activeTabId: s.activeTabId,
    };
  }));

  paneStatusClock.retain(livePaneKeys);
  claudeBackground.retain(liveClaudePanes);

  // Add lost sessions (existed before reboot but not in herdr now)
  const lastKnown = await getLastKnownSessions();
  const lostSessions: LastKnownSession[] = [];
  const stillHere = liveSessionMatcher(herdrSessions);
  for (const lost of lastKnown) {
    if (stillHere(lost)) continue;
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
      unseen: undefined,
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
