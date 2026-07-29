import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversationService } from '../../src/services/codex-conversation';

let scratch: string;
let rolloutPath: string;

function writeRollout(lines: object[]): void {
  const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(rolloutPath, text);
}

describe('CodexConversationService', () => {
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cchub-codex-conv-'));
    rolloutPath = join(scratch, 'rollout.jsonl');
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test('parses user/agent messages in order', () => {
    writeRollout([
      { timestamp: '2026-05-07T09:47:05Z', type: 'session_meta', payload: {} },
      { timestamp: '2026-05-07T09:47:30Z', type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } },
      { timestamp: '2026-05-07T09:47:35Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Hey', phase: 'commentary' } },
      { timestamp: '2026-05-07T09:48:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'What is on the schedule today?' } },
      { timestamp: '2026-05-07T09:48:05Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Two meetings' } },
    ]);

    const svc = new CodexConversationService();
    const messages = svc.parseRollout(rolloutPath);
    expect(messages).toEqual([
      { role: 'user', content: 'Hello', timestamp: '2026-05-07T09:47:30Z' },
      { role: 'assistant', content: 'Hey', timestamp: '2026-05-07T09:47:35Z' },
      { role: 'user', content: 'What is on the schedule today?', timestamp: '2026-05-07T09:48:00Z' },
      { role: 'assistant', content: 'Two meetings', timestamp: '2026-05-07T09:48:05Z' },
    ]);
  });

  test('attaches function_call/output as toolUse/toolResult', () => {
    writeRollout([
      { timestamp: '2026-05-07T09:47:30Z', type: 'event_msg', payload: { type: 'user_message', message: 'run ls' } },
      { timestamp: '2026-05-07T09:47:31Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Listing them now' } },
      { timestamp: '2026-05-07T09:47:32Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'c1' } },
      { timestamp: '2026-05-07T09:47:33Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'a\nb\nc' } },
      { timestamp: '2026-05-07T09:47:34Z', type: 'event_msg', payload: { type: 'agent_message', message: 'I can see a, b, c' } },
    ]);

    const svc = new CodexConversationService();
    const messages = svc.parseRollout(rolloutPath);
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[0].content).toBe('run ls');
    expect(messages[1].content).toBe('Listing them now');
    expect(messages[1].toolUse?.[0]).toEqual({ id: 'c1', name: 'exec_command', input: { cmd: 'ls' } });
    expect(messages[2].toolResult?.[0]).toEqual({ toolUseId: 'c1', toolName: 'exec_command', output: 'a\nb\nc' });
    expect(messages[3].content).toBe('I can see a, b, c');
  });

  test('joins consecutive agent_messages with a blank line', () => {
    writeRollout([
      { timestamp: '2026-05-07T09:47:30Z', type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: '2026-05-07T09:47:31Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Thinking' } },
      { timestamp: '2026-05-07T09:47:32Z', type: 'event_msg', payload: { type: 'agent_message', message: 'On to the next step' } },
    ]);
    const svc = new CodexConversationService();
    const messages = svc.parseRollout(rolloutPath);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Thinking\n\nOn to the next step');
  });

  test('returns empty array on missing file', () => {
    const svc = new CodexConversationService();
    expect(svc.parseRollout(join(scratch, 'does-not-exist.jsonl'))).toEqual([]);
  });

  test('tolerates malformed lines', () => {
    writeFileSync(rolloutPath, [
      '{not json}',
      '',
      JSON.stringify({ timestamp: '2026-05-07T09:47:30Z', type: 'event_msg', payload: { type: 'user_message', message: 'ok' } }),
    ].join('\n'));

    const svc = new CodexConversationService();
    const messages = svc.parseRollout(rolloutPath);
    expect(messages).toEqual([
      { role: 'user', content: 'ok', timestamp: '2026-05-07T09:47:30Z' },
    ]);
  });

  test('returns [] when threadId is unknown (no DB)', async () => {
    const svc = new CodexConversationService(join(scratch, 'no-db.sqlite'));
    expect(await svc.getConversation('whatever')).toEqual([]);
  });
});
