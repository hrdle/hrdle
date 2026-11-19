import { addAgentStatusListener } from './herdr-agent-status';
import { herdrRpc } from './herdr-client';

/**
 * When each pane entered the status it is in.
 *
 * herdr reports a status and a sequence number for its changes, never a time,
 * so the only clock available is this process noticing that a status differs
 * from the one it saw last. A pane's first sighting therefore has no time: it
 * was already in that state when the server started, for an unknown while.
 */
export class PaneStatusClock {
  private seen = new Map<string, { status: string; since: number | null }>();

  /** Milliseconds since the epoch, or null when the change was not witnessed. */
  observe(key: string, status: string | undefined, now: number): number | null {
    if (!status) return null;
    const prev = this.seen.get(key);
    if (prev && prev.status === status) return prev.since;
    const since = prev ? now : null;
    this.seen.set(key, { status, since });
    return since;
  }

  /**
   * Forget panes that are gone. herdr hands a closed workspace's id to the next
   * one it creates, so a remembered entry would otherwise date a new pane from
   * an old pane's last change.
   */
  retain(liveKeys: Set<string>): void {
    for (const key of this.seen.keys()) {
      if (!liveKeys.has(key)) this.seen.delete(key);
    }
  }
}

export const paneStatusClock = new PaneStatusClock();

async function stamp(): Promise<void> {
  try {
    const res = await herdrRpc<{
      agents?: Array<{ pane_id?: string; agent_status?: string }>;
    }>('agent.list', {});
    const now = Date.now();
    for (const a of res.agents ?? []) {
      if (a.pane_id) paneStatusClock.observe(a.pane_id, a.agent_status, now);
    }
  } catch {
    // herdr away: the next change, or the next list build, catches up
  }
}

/**
 * Date changes as herdr reports them, whether or not anyone is connected.
 *
 * The session list also feeds the clock, but it is only built while a client
 * is there to receive it. Left to that alone, an agent that finished overnight
 * is dated from the moment somebody opened the page the next morning.
 */
export function startPaneStatusClock(): void {
  void stamp();
  addAgentStatusListener(() => void stamp());
}
