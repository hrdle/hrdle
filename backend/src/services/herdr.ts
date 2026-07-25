/**
 * HerdrService — workspace-level operations on the herdr backend.
 *
 * A CC Hub workspace is a herdr workspace. Its public id is the workspace
 * label (falling back to workspace_id); the wire still calls this the
 * "session id" until the API rename lands. herdr's agent.list response is
 * authoritative for the agent provider and native session identity of each
 * pane (that "session" is the agent conversation, a different concept).
 */

import { isAgentProvider, type AgentProvider, type TabInfo } from '../../../shared/types';
import {
  herdrRpc,
  listPanes,
  listTabs,
  listWorkspaces,
  readPaneText,
  toTmuxPaneId,
  type HerdrAgentStatus,
  type HerdrWorkspace,
} from './herdr-client';
import { herdrControlSessions } from './herdr-control';

interface HerdrPaneInfo {
  paneId: string;
  command: string;
  path: string;
  agent?: AgentProvider;
  agentSessionId?: string;
  agentStatus?: HerdrAgentStatus;
  isActive: boolean;
  pid?: number;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  instanceId?: string;
  createdAt: string;
  attached: boolean;
  currentCommand?: string;
  agent?: AgentProvider;
  currentPath?: string;
  preview?: string;
  panes?: HerdrPaneInfo[];
  /** Native agent session id (e.g. Claude conversation UUID) reported by the
   *  herdr agent integration hook. Authoritative for .jsonl matching — two
   *  sessions in the same workingDir stay distinguishable. */
  agentSessionId?: string;
  /** herdr's own agent detection, verified against Claude 2.x on herdr 0.7.3:
   *  `working` while it responds, `blocked` while a TUI prompt waits on the
   *  user (AskUserQuestion / permission), `idle` before a turn, `done` after
   *  one, `unknown` when no agent is on the pane. Drives the indicator, so
   *  hooks no longer have to report every state transition. */
  agentStatus?: HerdrAgentStatus;
  /** Tabs of this workspace, present only when it has more than one tab. */
  tabs?: TabInfo[];
  activeTabId?: string;
}

export interface HerdrAgentRecord {
  pane_id?: string;
  agent?: string;
  agent_status?: HerdrAgentStatus;
  agent_session?: { kind?: string; value?: string };
}

export interface HerdrAgentPane {
  agent: AgentProvider;
  sessionId?: string;
  status?: HerdrAgentStatus;
}

export function indexHerdrAgentPanes(
  agents: HerdrAgentRecord[],
): Map<string, HerdrAgentPane> {
  const map = new Map<string, HerdrAgentPane>();
  for (const record of agents) {
    if (!record.pane_id || !record.agent || !isAgentProvider(record.agent)) continue;
    map.set(record.pane_id, {
      agent: record.agent,
      sessionId:
        record.agent_session?.kind === 'id' && record.agent_session.value
          ? record.agent_session.value
          : undefined,
      status: record.agent_status,
    });
  }
  return map;
}

export function herdrPaneCommand(leader: string, agentPane?: HerdrAgentPane): string {
  return agentPane?.agent ?? leader.split(/\s+/)[0]?.split('/').pop() ?? '';
}

/** Session id for a workspace: label when present, else the workspace id. */
function workspaceSessionId(ws: HerdrWorkspace): string {
  return ws.label && ws.label.trim() !== '' ? ws.label : ws.workspace_id;
}

export class HerdrService {
  private listWorkspacesCache: { data: WorkspaceInfo[]; timestamp: number } | null = null;
  private static readonly LIST_WORKSPACES_CACHE_TTL = 2000;
  // pane process info cache (pane_id → foreground process snapshot)
  private processCmdCache = new Map<
    string,
    { leader: string; pid?: number; timestamp: number }
  >();
  private static readonly PROCESS_CMD_CACHE_TTL = 3000;

  private async resolveWorkspace(sessionId: string): Promise<HerdrWorkspace | null> {
    try {
      const workspaces = await listWorkspaces();
      return (
        workspaces.find((w) => workspaceSessionId(w) === sessionId) ??
        workspaces.find((w) => w.workspace_id === sessionId) ??
        null
      );
    } catch {
      return null;
    }
  }

  private async paneProcesses(
    herdrPaneId: string,
  ): Promise<{ leader: string; pid?: number }> {
    const cached = this.processCmdCache.get(herdrPaneId);
    if (cached && Date.now() - cached.timestamp < HerdrService.PROCESS_CMD_CACHE_TTL) {
      return cached;
    }
    try {
      const res = await herdrRpc<{
        process_info?: {
          shell_pid?: number;
          foreground_processes?: Array<{
            pid?: number;
            name?: string;
            argv?: string[];
            cmdline?: string;
          }>;
        };
      }>('pane.process_info', { pane_id: herdrPaneId });
      // The first foreground process is used only as the plain-shell command
      // and metrics PID. Agent identity comes exclusively from agent.list.
      const procs = res.process_info?.foreground_processes ?? [];
      const leaderProc = procs[0];
      const entry = {
        leader: leaderProc?.name || leaderProc?.cmdline || '',
        pid: typeof leaderProc?.pid === 'number' ? leaderProc.pid : undefined,
        timestamp: Date.now(),
      };
      this.processCmdCache.set(herdrPaneId, entry);
      return entry;
    } catch {
      const entry = { leader: '', timestamp: Date.now() };
      this.processCmdCache.set(herdrPaneId, entry);
      return entry;
    }
  }

  /**
   * pane_id → agent provider + native session id, as reported by herdr.
   * The provider is available from herdr's runtime detection; sessionId is
   * present only when that provider's herdr integration is installed.
   */
  private async listAgentPanes(): Promise<Map<string, HerdrAgentPane>> {
    try {
      const res = await herdrRpc<{ agents?: HerdrAgentRecord[] }>('agent.list', {});
      return indexHerdrAgentPanes(res.agents ?? []);
    } catch {
      // enrichment only
    }
    return new Map();
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    if (
      this.listWorkspacesCache &&
      Date.now() - this.listWorkspacesCache.timestamp < HerdrService.LIST_WORKSPACES_CACHE_TTL
    ) {
      return this.listWorkspacesCache.data;
    }

    try {
      const [workspaces, allPanes, agentPanes] = await Promise.all([
        listWorkspaces(),
        listPanes(),
        this.listAgentPanes(),
      ]);

      const result: WorkspaceInfo[] = await Promise.all(
        workspaces.map(async (ws) => {
          // Only the active tab's panes represent the session: herdr stacks
          // multiple tabs' panes under one workspace, but the terminal view
          // (HerdrControlSession) renders a single tab, so the list must agree
          // or the pane count / preview would count panes the user can't see.
          const wsPanes = allPanes.filter(
            (p) =>
              p.workspace_id === ws.workspace_id &&
              (!ws.active_tab_id || p.tab_id === ws.active_tab_id),
          );
          const panes: HerdrPaneInfo[] = await Promise.all(
            wsPanes.map(async (p) => {
              const tmuxId = toTmuxPaneId(p.pane_id) ?? p.pane_id;
              const { leader, pid } = await this.paneProcesses(p.pane_id);
              const agentPane = agentPanes.get(p.pane_id);
              return {
                paneId: tmuxId,
                command: herdrPaneCommand(leader, agentPane),
                path: p.foreground_cwd || p.cwd || '',
                agent: agentPane?.agent,
                agentSessionId: agentPane?.sessionId,
                agentStatus: agentPane?.status ?? p.agent_status,
                isActive: p.focused,
                pid,
              };
            }),
          );

          // Keep the representative session fields paired to one pane. Prefer
          // the currently focused agent pane, then the first agent pane.
          const agentPane =
            panes.find((p) => p.isActive && p.agent) ?? panes.find((p) => p.agent);
          const agent = agentPane?.agent;

          const rootPane = wsPanes[0];
          const rootHerdrId = rootPane?.pane_id;
          let preview: string | undefined;
          if (rootHerdrId) {
            const text = await readPaneText(rootHerdrId, 'recent', 15);
            if (text) {
              preview =
                text
                  .split('\n')
                  .map((l) => l.trim())
                  .filter((l) => l.length > 0)
                  .slice(-3)
                  .join(' ')
                  .slice(0, 100) || undefined;
            }
          }

          const currentPath = agentPane?.path ?? rootPane?.foreground_cwd ?? rootPane?.cwd;
          const agentSessionId = agentPane?.agentSessionId;
          // `blocked` anywhere in the workspace wins: an agent waiting on a
          // prompt is the state the user has to act on, even if the split it
          // sits in isn't the one we matched an agent process to.
          const agentStatus: HerdrAgentStatus | undefined = wsPanes.some(
            (p) => p.agent_status === 'blocked',
          )
            ? 'blocked'
            : agentPane?.agentStatus;

          // Tabs: a multi-tab workspace needs tab.list for real labels/counts;
          // the common single-tab case is derived from active_tab_id with no
          // extra RPC. Always populated (even for one tab) so the UI can offer
          // "new tab" and show the active tab without a chicken-and-egg gate.
          let tabs: TabInfo[] | undefined;
          if ((ws.tab_count ?? 1) > 1) {
            const herdrTabs = await listTabs(ws.workspace_id);
            if (herdrTabs.length > 0) {
              tabs = herdrTabs
                .slice()
                .sort((a, b) => a.number - b.number)
                .map((t) => ({
                  id: t.tab_id,
                  label: t.label || String(t.number),
                  paneCount: t.pane_count ?? 0,
                  active: t.tab_id === ws.active_tab_id,
                }));
            }
          } else if (ws.active_tab_id) {
            const num = ws.active_tab_id.match(/:t(\d+)$/)?.[1] ?? '1';
            tabs = [
              { id: ws.active_tab_id, label: num, paneCount: wsPanes.length, active: true },
            ];
          }

          return {
            id: workspaceSessionId(ws),
            name: workspaceSessionId(ws),
            instanceId: ws.workspace_id,
            createdAt: new Date(0).toISOString(),
            attached: ws.focused,
            currentCommand: agent ?? panes[0]?.command,
            agent,
            currentPath,
            preview,
            panes,
            agentSessionId,
            agentStatus,
            tabs,
            activeTabId: ws.active_tab_id,
          };
        }),
      );

      this.listWorkspacesCache = { data: result, timestamp: Date.now() };
      return result;
    } catch {
      return [];
    }
  }

  async capturePane(sessionId: string, lines: number = 15): Promise<string | null> {
    const ws = await this.resolveWorkspace(sessionId);
    if (!ws) return null;
    try {
      const panes = await listPanes(ws.workspace_id);
      const root = panes[0];
      if (!root) return null;
      return await readPaneText(root.pane_id, 'recent', lines);
    } catch {
      return null;
    }
  }

  async capturePreview(sessionId: string, lines: number = 5): Promise<string | null> {
    const text = await this.capturePane(sessionId, lines);
    if (!text) return null;
    const cleaned = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(-3)
      .join(' ')
      .slice(0, 100);
    return cleaned || null;
  }

  async captureScrollback(sessionId: string, lines: number = 1000): Promise<string | null> {
    return this.capturePane(sessionId, Math.min(lines, 1000));
  }

  invalidateCache(): void {
    this.listWorkspacesCache = null;
    this.processCmdCache.clear();
  }

  async createWorkspace(name: string): Promise<string> {
    this.invalidateCache();
    const existing = await this.resolveWorkspace(name);
    if (existing) {
      throw new Error(`Failed to create session: workspace "${name}" already exists`);
    }
    await herdrRpc('workspace.create', {
      label: name,
      cwd: process.env.HOME || '/tmp',
    });
    const created = await this.resolveWorkspace(name);
    return created?.workspace_id ?? name;
  }

  /**
   * Move a session's workspace to `targetIndex` in herdr's workspace order.
   * herdr IS the session order — there is no cchub-side order to keep in sync.
   *
   * herdr's `insert_index` means "insert before the workspace currently at
   * that index", evaluated against the list with the moved workspace still in
   * it. Moving backward (to a smaller index) therefore lands exactly on the
   * index, but moving forward lands one slot short, so compensate. Verified
   * against herdr 0.7.3/0.7.4: index 13 → insert 0 lands at 0; index 0 →
   * insert 5 lands at 4.
   */
  async moveWorkspace(sessionId: string, targetIndex: number): Promise<boolean> {
    const workspaces = await listWorkspaces();
    const current = workspaces.findIndex(
      (w) => workspaceSessionId(w) === sessionId || w.workspace_id === sessionId,
    );
    if (current === -1) return false;

    const clamped = Math.max(0, Math.min(targetIndex, workspaces.length - 1));
    if (clamped === current) return true;

    const insertIndex = current < clamped ? clamped + 1 : clamped;
    await herdrRpc('workspace.move', {
      workspace_id: workspaces[current].workspace_id,
      insert_index: insertIndex,
    });
    // The 2s list cache would otherwise serve the pre-move order back to the
    // very next sessions push and snap the dragged row back.
    this.invalidateCache();
    return true;
  }

  async killWorkspace(sessionId: string): Promise<void> {
    this.invalidateCache();
    const ws = await this.resolveWorkspace(sessionId);
    if (!ws) {
      throw new Error(`Failed to kill session: workspace not found: ${sessionId}`);
    }
    await herdrRpc('workspace.close', { workspace_id: ws.workspace_id });
    // Reap the control session immediately. Left in the registry, it would
    // be handed out for a future same-name workspace while still bound to
    // the closed one (blank viewports, dead-pane controller spawn loops).
    herdrControlSessions.get(sessionId)?.terminate('workspace closed');
  }

  async workspaceExists(sessionId: string): Promise<boolean> {
    return (await this.resolveWorkspace(sessionId)) !== null;
  }
}
