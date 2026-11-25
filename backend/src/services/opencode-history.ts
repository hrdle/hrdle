import type { ConversationMessage, ToolResultInfo, ToolUseInfo } from '../../../shared/types';
import { ListedHistoryProvider } from './agent-history-listing';
import { OpenCodeSessionStore, type OpenCodeSessionInfo } from './opencode';

/** A `part.data` row, discriminated by `type`. */
interface OpenCodePart {
  type?: unknown;
  text?: unknown;
  tool?: unknown;
  callID?: unknown;
  state?: {
    status?: unknown;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    title?: unknown;
  };
}

/**
 * The result half of a `tool` part. A failed call carries its message in
 * `state.error` and has **no** `output` — OpenCode asks permission before most
 * tools, so "the user rejected permission" is an everyday path, not an edge
 * case. Reading only `output` would render a rejected call identically to one
 * still running, and `ToolCard` has a red, auto-expanded treatment for
 * `isError` that would never be reached.
 */
function toolOutcome(state: OpenCodePart['state']): { output: string; isError?: boolean } | undefined {
  if (state?.status === 'error') {
    const error = typeof state.error === 'string' && state.error ? state.error : 'Tool call failed';
    return { output: error, isError: true };
  }
  return typeof state?.output === 'string' && state.output ? { output: state.output } : undefined;
}

function parseToolInput(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Collapse one OpenCode session's messages into Claude-shaped conversation
 * turns:
 *  - user message `text` part      → role=user
 *  - assistant `text` part         → role=assistant text
 *  - `reasoning` part              → dropped (internal, like Kimi's `think`)
 *  - `tool` part                   → ToolUseInfo on the assistant turn, plus a
 *    ToolResultInfo on a following user turn once the call has settled (with an
 *    output, or with an error). OpenCode stores the call and its result in ONE
 *    row, but the viewer pairs them by `toolUseId` across an assistant/user turn
 *    boundary, so the row is split back out into that shape.
 *  - `step-start` / `step-finish`  → dropped (step bookkeeping and token counts)
 */
export function parseOpenCodeMessages(messages: Array<{ id?: string; role: string; parts: string[] }>): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  let current: ConversationMessage | null = null;

  const flush = () => {
    if (!current) return;
    const hasContent = !!current.content || !!current.toolUse?.length || !!current.toolResult?.length;
    if (hasContent) result.push(current);
    current = null;
  };

  // The id of the row that opened this turn. Several rows can merge into one
  // turn, and the anchor points at where it starts.
  const ensureRole = (role: 'user' | 'assistant', id?: string): ConversationMessage => {
    if (current?.role !== role) {
      flush();
      current = { role, content: '', ...(id ? { id } : {}) };
    }
    return current as ConversationMessage;
  };

  for (const message of messages) {
    const role: 'user' | 'assistant' = message.role === 'user' ? 'user' : 'assistant';

    for (const raw of message.parts) {
      let part: OpenCodePart;
      try {
        part = JSON.parse(raw) as OpenCodePart;
      } catch {
        continue;
      }

      if (part.type === 'text') {
        const text = typeof part.text === 'string' ? part.text.trim() : '';
        if (!text) continue;
        const turn = ensureRole(role, message.id);
        turn.content = turn.content ? `${turn.content}\n\n${text}` : text;
        continue;
      }

      if (part.type !== 'tool') continue;

      const id = typeof part.callID === 'string' ? part.callID : '';
      const name = typeof part.tool === 'string' ? part.tool : 'tool';
      const tool: ToolUseInfo = { id, name, input: parseToolInput(part.state?.input) };
      const callTurn = ensureRole('assistant');
      callTurn.toolUse = callTurn.toolUse ? [...callTurn.toolUse, tool] : [tool];

      const outcome = toolOutcome(part.state);
      if (!outcome) continue;
      const resultTurn = ensureRole('user');
      const toolResult: ToolResultInfo = { toolUseId: id, toolName: name, ...outcome };
      resultTurn.toolResult = resultTurn.toolResult ? [...resultTurn.toolResult, toolResult] : [toolResult];
    }
  }

  flush();
  return result;
}

/** Reads OpenCode session history from its SQLite store. */
export class OpenCodeHistoryService extends ListedHistoryProvider<OpenCodeSessionInfo> {
  constructor(private readonly store = new OpenCodeSessionStore()) {
    super('opencode');
  }

  /**
   * Projects group by `session.directory`. The `project` table is not used:
   * its `global` row is a catch-all whose `worktree` changes as other
   * directories are visited, so grouping by it would move sessions between
   * projects.
   */
  protected listSessions(): Promise<OpenCodeSessionInfo[]> {
    return this.store.listSessions();
  }

  async getConversation(sessionId: string): Promise<ConversationMessage[]> {
    return parseOpenCodeMessages(this.store.getSessionParts(sessionId));
  }
}
