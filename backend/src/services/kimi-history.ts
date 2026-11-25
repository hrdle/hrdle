import { readFile } from 'node:fs/promises';
import type { ConversationMessage, ToolResultInfo, ToolUseInfo } from '../../../shared/types';
import { ListedHistoryProvider } from './agent-history-listing';
import { KimiSessionStore, kimiWirePath, turnPromptText, type KimiSessionInfo } from './kimi';

interface KimiWireRecord {
  type?: string;
  input?: unknown;
  origin?: { kind?: unknown };
  event?: {
    type?: string;
    toolCallId?: unknown;
    name?: unknown;
    args?: unknown;
    result?: unknown;
    part?: { type?: unknown; text?: unknown };
  };
}

/** Tool result payloads are `{output, note?, truncated?}` objects (or a plain string). */
function toolResultOutput(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof (result as { output?: unknown }).output === 'string') {
    return (result as { output: string }).output;
  }
  return '';
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Collapse a Kimi Code main `wire.jsonl` into Claude-shaped conversation turns:
 *  - `turn.prompt` (origin user)        → role=user
 *  - loop event `content.part` (text)   → role=assistant text (`think` parts
 *    are dropped)
 *  - loop event `tool.call`             → ToolUseInfo on the assistant turn
 *  - loop event `tool.result`           → ToolResultInfo on a user turn
 *    (toolName resolved from the matching tool.call id)
 *  - `context.append_message`           → dropped: user payloads duplicate the
 *    `turn.prompt` records and the rest is injected context
 *  - metadata / config / step / llm / usage / plan_mode / permission records
 *    → dropped
 */
export function parseKimiWire(text: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let current: ConversationMessage | null = null;
  const callIdToName = new Map<string, string>();

  const flush = () => {
    if (!current) return;
    const hasContent = !!current.content || !!current.toolUse?.length || !!current.toolResult?.length;
    if (hasContent) messages.push(current);
    current = null;
  };

  const ensureRole = (role: 'user' | 'assistant'): ConversationMessage => {
    if (current?.role !== role) {
      flush();
      current = { role, content: '' };
    }
    return current as ConversationMessage;
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: KimiWireRecord;
    try {
      record = JSON.parse(trimmed) as KimiWireRecord;
    } catch {
      continue;
    }

    if (record.type === 'turn.prompt') {
      const content = turnPromptText(record).trim();
      if (!content) continue;
      flush();
      messages.push({ role: 'user', content });
      continue;
    }

    if (record.type !== 'context.append_loop_event') continue;
    const event = record.event;
    if (!event) continue;

    if (event.type === 'content.part' && event.part?.type === 'text' && typeof event.part.text === 'string') {
      const content = event.part.text;
      if (!content) continue;
      const turn = ensureRole('assistant');
      turn.content = turn.content ? `${turn.content}\n\n${content}` : content;
      continue;
    }

    if (event.type === 'tool.call') {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      const name = typeof event.name === 'string' ? event.name : 'tool';
      if (id) callIdToName.set(id, name);
      const tool: ToolUseInfo = { id, name, input: parseToolArgs(event.args) };
      const turn = ensureRole('assistant');
      turn.toolUse = turn.toolUse ? [...turn.toolUse, tool] : [tool];
      continue;
    }

    if (event.type === 'tool.result') {
      const callId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      const turn = ensureRole('user');
      const result: ToolResultInfo = {
        toolUseId: callId,
        toolName: callIdToName.get(callId),
        output: toolResultOutput(event.result),
      };
      turn.toolResult = turn.toolResult ? [...turn.toolResult, result] : [result];
    }
  }

  flush();
  return messages;
}

/** Reads Kimi Code session history from `~/.kimi-code/sessions`. */
export class KimiHistoryService extends ListedHistoryProvider<KimiSessionInfo> {
  constructor(private readonly store = new KimiSessionStore()) {
    super('kimi');
  }

  protected listSessions(): Promise<KimiSessionInfo[]> {
    return this.store.listSessions();
  }

  async getConversation(sessionId: string): Promise<ConversationMessage[]> {
    const session = await this.store.findSession(sessionId);
    if (!session) return [];
    try {
      const text = await readFile(kimiWirePath(session.dir), 'utf8');
      return parseKimiWire(text);
    } catch {
      return [];
    }
  }
}
