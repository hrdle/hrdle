import type { ServerWebSocket } from 'bun';
import { ConversationWatcher } from '../../services/conversation-watcher';
import { HerdrService, findSessionByAddress } from '../../services/herdr';
import type { ConversationMessage } from '../../../../shared/types';
import { activeMuxConnections, type MuxData } from './connections';

const herdrService = new HerdrService();

/**
 * Watcher key.
 *
 * A workspace is not a conversation: two agent panes in one workspace are two,
 * and keying the watcher by workspace alone meant the second subscription
 * silently tore down the first.
 */
function conversationKey(sessionId: string, agentSessionId?: string): string {
  return agentSessionId ? `${sessionId}\u0000${agentSessionId}` : sessionId;
}

export async function handleSubscribeConversation(
  ws: ServerWebSocket<MuxData>,
  sessionId: string,
  agentSessionId?: string,
) {
  console.log(`[mux] subscribe-conversation: ${sessionId}${agentSessionId ? ` agent=${agentSessionId}` : ''}`);
  const key = conversationKey(sessionId, agentSessionId);

  const existing = ws.data.conversationWatchers.get(key);
  if (existing) {
    try { existing.stop(); } catch { /* ignore */ }
    ws.data.conversationWatchers.delete(key);
  }

  let workingDir: string | undefined;
  try {
    const sessions = await herdrService.listWorkspaces();
    const { session } = findSessionByAddress(sessions, sessionId);
    // The pane's own directory, not the workspace's. `currentPath` is the
    // first agent pane's, so a second pane working elsewhere would have been
    // read against a project directory it has no transcript in.
    const pane = agentSessionId
      ? session?.panes?.find(p => p.agentSessionId === agentSessionId)
      : undefined;
    workingDir = pane?.path || session?.currentPath;
  } catch (err) {
    console.warn(`[mux] subscribe-conversation: failed to list sessions: ${err}`);
  }

  if (!workingDir) {
    try {
      ws.send(JSON.stringify({ type: 'conversation-subscribed', sessionId, agentSessionId, ccSessionId: null }));
      ws.send(JSON.stringify({ type: 'initial-conversation', sessionId, agentSessionId, messages: [] }));
    } catch { /* disconnected */ }
    return;
  }

  const watcher = new ConversationWatcher();
  let initialMessages: ConversationMessage[] = [];
  try {
    initialMessages = await watcher.start(workingDir, agentSessionId);
  } catch (err) {
    console.warn(`[mux] subscribe-conversation start failed for ${sessionId}:`, err);
  }

  // The client can disconnect while watcher.start() is in flight. muxClose
  // has already run at that point and didn't see this watcher, so its
  // FSWatcher would keep running forever.
  if (!activeMuxConnections.has(ws)) {
    console.log(`[mux] client disconnected during subscribe-conversation to ${sessionId}; stopping watcher`);
    try { watcher.stop(); } catch { /* ignore */ }
    return;
  }

  watcher.onFound((ccSessionId) => {
    try {
      ws.send(JSON.stringify({ type: 'conversation-subscribed', sessionId, agentSessionId, ccSessionId }));
    } catch { /* disconnected */ }
  });
  watcher.onUpdate((newMessages) => {
    try {
      ws.send(JSON.stringify({ type: 'conversation-update', sessionId, agentSessionId, messages: newMessages }));
    } catch { /* disconnected */ }
  });

  ws.data.conversationWatchers.set(key, watcher);

  try {
    ws.send(JSON.stringify({
      type: 'conversation-subscribed',
      sessionId,
      agentSessionId,
      ccSessionId: watcher.getCcSessionId(),
    }));
    ws.send(JSON.stringify({
      type: 'initial-conversation',
      sessionId,
      agentSessionId,
      messages: initialMessages,
    }));
  } catch { /* disconnected */ }
}

export function handleUnsubscribeConversation(
  ws: ServerWebSocket<MuxData>,
  sessionId: string,
  agentSessionId?: string,
) {
  console.log(`[mux] unsubscribe-conversation: ${sessionId}${agentSessionId ? ` agent=${agentSessionId}` : ''}`);
  const key = conversationKey(sessionId, agentSessionId);
  const watcher = ws.data.conversationWatchers.get(key);
  if (watcher) {
    try { watcher.stop(); } catch { /* ignore */ }
    ws.data.conversationWatchers.delete(key);
  }
  try {
    ws.send(JSON.stringify({ type: 'conversation-unsubscribed', sessionId, agentSessionId }));
  } catch { /* disconnected */ }
}
