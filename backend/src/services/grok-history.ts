import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConversationMessage, ToolResultInfo, ToolUseInfo } from '../../../shared/types';
import { ListedHistoryProvider } from './agent-history-listing';
import { GrokSessionStore, type GrokSessionInfo } from './grok';

interface GrokChatRecord {
  type?: string;
  content?: unknown;
  synthetic_reason?: string;
  prompt_index?: number;
  tool_calls?: Array<{ id?: string; name?: string; arguments?: string }>;
  tool_call_id?: string;
}

/** Flatten a Grok content field (plain string or `[{type:'text',text}]` parts). */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Headless (`grok -p`) prompts arrive wrapped in `<user_query>` tags. */
function stripUserQueryWrapper(text: string): string {
  const match = text.match(/^\s*<user_query>\n?([\s\S]*?)\n?<\/user_query>\s*$/);
  return match ? match[1] : text;
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : { value };
  } catch {
    return { raw };
  }
}

/**
 * Collapse a Grok `chat_history.jsonl` into Claude-shaped conversation turns:
 *  - `user` with `prompt_index`      → role=user (real prompts; records with a
 *    `synthetic_reason` or no index are injected context, not conversation)
 *  - `assistant`                     → role=assistant text + ToolUseInfo from
 *    `tool_calls`
 *  - `tool_result`                   → ToolResultInfo on a user turn (toolName
 *    resolved from the matching tool_call id)
 *  - `system` / `reasoning`          → dropped (reasoning is encrypted)
 */
export function parseGrokChatHistory(text: string): ConversationMessage[] {
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
    let record: GrokChatRecord;
    try {
      record = JSON.parse(trimmed) as GrokChatRecord;
    } catch {
      continue;
    }

    if (record.type === 'user') {
      if (record.synthetic_reason !== undefined || record.prompt_index === undefined) continue;
      flush();
      const content = stripUserQueryWrapper(contentText(record.content)).trim();
      if (content) messages.push({ role: 'user', content });
      continue;
    }

    if (record.type === 'assistant') {
      const content = contentText(record.content);
      const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      if (!content && toolCalls.length === 0) continue;
      const turn = ensureRole('assistant');
      if (content) {
        turn.content = turn.content ? `${turn.content}\n\n${content}` : content;
      }
      for (const call of toolCalls) {
        const id = typeof call.id === 'string' ? call.id : '';
        const name = typeof call.name === 'string' ? call.name : 'tool';
        if (id) callIdToName.set(id, name);
        const tool: ToolUseInfo = { id, name, input: parseToolArguments(call.arguments) };
        turn.toolUse = turn.toolUse ? [...turn.toolUse, tool] : [tool];
      }
      continue;
    }

    if (record.type === 'tool_result') {
      const callId = typeof record.tool_call_id === 'string' ? record.tool_call_id : '';
      const turn = ensureRole('user');
      const result: ToolResultInfo = {
        toolUseId: callId,
        toolName: callIdToName.get(callId),
        output: contentText(record.content),
      };
      turn.toolResult = turn.toolResult ? [...turn.toolResult, result] : [result];
    }
    // 'system' and 'reasoning' records are intentionally dropped.
  }

  flush();
  return messages;
}

/** Reads Grok Build session history from `~/.grok/sessions`. */
export class GrokHistoryService extends ListedHistoryProvider<GrokSessionInfo> {
  constructor(private readonly store = new GrokSessionStore()) {
    super('grok');
  }

  protected listSessions(): Promise<GrokSessionInfo[]> {
    return this.store.listSessions();
  }

  async getConversation(sessionId: string): Promise<ConversationMessage[]> {
    const session = await this.store.findSession(sessionId);
    if (!session) return [];
    try {
      const text = await readFile(join(session.dir, 'chat_history.jsonl'), 'utf8');
      return parseGrokChatHistory(text);
    } catch {
      return [];
    }
  }
}
