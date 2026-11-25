import type { ConversationMessage, ToolResultInfo, ToolUseInfo } from '../../../shared/types';
import { ListedHistoryProvider } from './agent-history-listing';
import { blockText, parsePiRecord, type PiContentBlock, type PiSessionInfo, PiSessionStore } from './pi';

function toolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // not JSON: keep the string as the one argument
    }
    return { input: raw };
  }
  return {};
}

/**
 * A pi transcript as the conversation viewer draws it.
 *
 * pi writes a tool's result as a message of its own with `role: "toolResult"`,
 * which is the shape the viewer already pairs: the call sits on the assistant
 * turn and the result on the user turn after it, joined by the call id.
 * Thinking blocks ride on the assistant turn; settings changes and extension
 * records are not conversation.
 */
export function parsePiSession(text: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const line of text.split('\n')) {
    const record = parsePiRecord(line);
    if (record?.type !== 'message' || !record.message) continue;
    const message = record.message;
    const blocks: PiContentBlock[] = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'user') {
      messages.push({ id: record.id, role: 'user', content: blockText(message.content), timestamp: record.timestamp });
    } else if (message.role === 'assistant') {
      const toolUse: ToolUseInfo[] = blocks
        .filter((b) => b.type === 'toolCall' && typeof b.id === 'string' && typeof b.name === 'string')
        .map((b) => ({ id: b.id as string, name: b.name as string, input: toolArgs(b.arguments) }));
      const thinking = blocks
        .filter((b) => b.type === 'thinking' && typeof b.thinking === 'string')
        .map((b) => b.thinking as string)
        .join('\n')
        .trim();
      messages.push({
        id: record.id,
        role: 'assistant',
        content: blockText(message.content),
        timestamp: record.timestamp,
        ...(thinking ? { thinking } : {}),
        ...(toolUse.length > 0 ? { toolUse } : {}),
      });
    } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const images = blocks
        .filter((b) => b.type === 'image' && typeof b.data === 'string')
        .map((b) => ({ mediaType: b.mimeType ?? b.mediaType ?? 'image/png', data: b.data as string }));
      const result: ToolResultInfo = {
        toolUseId: message.toolCallId,
        toolName: message.toolName,
        output: blockText(message.content),
        ...(images.length > 0 ? { images } : {}),
        ...(message.isError ? { isError: true } : {}),
      };
      messages.push({ id: record.id, role: 'user', content: '', timestamp: record.timestamp, toolResult: [result] });
    }
  }
  return messages;
}

/** Reads pi session history from `~/.pi/agent/sessions`. */
export class PiHistoryService extends ListedHistoryProvider<PiSessionInfo> {
  constructor(private readonly store = new PiSessionStore()) {
    super('pi');
  }

  protected listSessions(): Promise<PiSessionInfo[]> {
    return this.store.listSessions();
  }

  async getConversation(sessionId: string): Promise<ConversationMessage[]> {
    const session = await this.store.findSession(sessionId);
    if (!session) return [];
    try {
      return parsePiSession(await this.store.readTranscript(session));
    } catch {
      return [];
    }
  }
}
