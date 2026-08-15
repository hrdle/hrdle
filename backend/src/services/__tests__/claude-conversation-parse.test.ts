import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationMessage } from '../../../../shared/types';
import { SessionHistoryService } from '../session-history';

/**
 * What the Claude `.jsonl` parser does today, pinned before it is changed.
 *
 * A broken transcript parser does not throw - it renders a conversation that is
 * subtly wrong, which nobody sees until they read one. This file exists so the
 * work that threads message ids through has something to fail against; every
 * assertion here describes behaviour that predates it.
 */

let dir: string;
const service = new SessionHistoryService();

/** The parser reads a file, so it is exercised through one. Private only to
 *  TypeScript, and the point is to test it exactly as it is. */
function parse(path: string): Promise<ConversationMessage[]> {
  return (service as unknown as { parseJsonlFile(p: string): Promise<ConversationMessage[]> }).parseJsonlFile(path);
}

async function write(lines: unknown[]): Promise<string> {
  const path = join(dir, 'conversation.jsonl');
  await writeFile(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return path;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-parse-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('what reaches the transcript', () => {
  it('keeps a plain exchange, with its timestamp', async () => {
    const messages = await parse(
      await write([
        { type: 'user', uuid: 'u1', timestamp: '2026-08-16T00:00:00Z', message: { content: 'hello' } },
        { type: 'assistant', uuid: 'a1', timestamp: '2026-08-16T00:00:01Z', message: { content: [{ type: 'text', text: 'hi' }] } },
      ]),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hello', timestamp: '2026-08-16T00:00:00Z' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'hi' });
    // The anchor a steward turn points back at.
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('joins text blocks and collects thinking separately', async () => {
    const messages = await parse(
      await write([
        {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [
              { type: 'thinking', thinking: 'first thought' },
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
              { type: 'thinking', thinking: 'second thought' },
            ],
          },
        },
      ]),
    );

    expect(messages[0].content).toBe('line one\nline two');
    expect(messages[0].thinking).toBe('first thought\n\nsecond thought');
  });

  it('ignores anything that is not a user or assistant message', async () => {
    const messages = await parse(
      await write([
        { type: 'summary', summary: 'a recap' },
        { type: 'system', content: 'noise' },
        { type: 'user' },
        { type: 'user', uuid: 'u1', message: { content: 'kept' } },
      ]),
    );

    expect(messages.map((m) => m.content)).toEqual(['kept']);
  });

  it('skips a line that is not JSON rather than losing the file', async () => {
    const messages = await parse(
      await write([
        { type: 'user', uuid: 'u1', message: { content: 'before' } },
        'this line is not json {',
        { type: 'user', uuid: 'u2', message: { content: 'after' } },
      ]),
    );

    expect(messages.map((m) => m.content)).toEqual(['before', 'after']);
  });

  it('drops a message with nothing in it', async () => {
    const messages = await parse(
      await write([
        { type: 'user', uuid: 'u1', message: { content: '' } },
        { type: 'assistant', uuid: 'a1', message: { content: [] } },
        { type: 'user', uuid: 'u2', message: { content: 'kept' } },
      ]),
    );

    expect(messages).toHaveLength(1);
  });
});

describe('tool calls and their results', () => {
  it('carries a call, and pairs the result with the call name', async () => {
    const messages = await parse(
      await write([
        {
          type: 'assistant',
          uuid: 'a1',
          message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.ts' } }] },
        },
        {
          type: 'user',
          uuid: 'u1',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }] },
        },
      ]),
    );

    expect(messages[0].toolUse).toEqual([{ id: 'tu_1', name: 'Read', input: { file_path: '/a.ts' } }]);
    // The name comes from the call, which is a message earlier - the pairing
    // ConversationViewer relies on to draw one card instead of two.
    expect(messages[1].toolResult?.[0]).toMatchObject({ toolUseId: 'tu_1', toolName: 'Read', output: 'file body' });
  });

  it('takes the text out of a block-shaped result and keeps images aside', async () => {
    const messages = await parse(
      await write([
        {
          type: 'user',
          uuid: 'u1',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_2',
                content: [
                  { type: 'text', text: 'line a' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
                  { type: 'text', text: 'line b' },
                ],
              },
            ],
          },
        },
      ]),
    );

    expect(messages[0].toolResult?.[0].output).toBe('line a\nline b');
    expect(messages[0].toolResult?.[0].images).toEqual([{ mediaType: 'image/png', data: 'AAAA' }]);
  });

  it('marks an error result as one', async () => {
    const messages = await parse(
      await write([
        {
          type: 'user',
          uuid: 'u1',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: 'boom', is_error: true }] },
        },
      ]),
    );

    expect(messages[0].toolResult?.[0].isError).toBe(true);
  });
});

describe('what the transcript hides', () => {
  it('drops the harness own messages', async () => {
    const messages = await parse(
      await write([
        { type: 'user', uuid: 'u1', message: { content: '<system-reminder>internal</system-reminder>' } },
        { type: 'user', uuid: 'u2', message: { content: '<local-command-caveat>internal</local-command-caveat>' } },
        { type: 'user', uuid: 'u3', message: { content: 'a person speaking' } },
      ]),
    );

    expect(messages.map((m) => m.content)).toEqual(['a person speaking']);
  });

  it('rewrites the command markup a person did not type', async () => {
    const messages = await parse(
      await write([
        { type: 'user', uuid: 'u1', message: { content: '<command-name>/release</command-name><command-args>v1</command-args>' } },
      ]),
    );

    expect(messages[0].content).toContain('Command: /release');
    expect(messages[0].content).not.toContain('<command-args>');
  });

  it('strips terminal escape sequences', async () => {
    // Written as \x1b rather than pasted: a raw ESC in a source file is
    // invisible in review and survives a copy only by luck.
    const coloured = '\x1b[31mred\x1b[0m plain';
    const messages = await parse(await write([{ type: 'user', uuid: 'u1', message: { content: coloured } }]));

    expect(messages[0].content).toBe('red plain');
  });

  it('truncates a very long message, and says so', async () => {
    const long = 'x'.repeat(6000);
    const messages = await parse(await write([{ type: 'user', uuid: 'u1', message: { content: long } }]));

    expect(messages[0].content).toContain('...(truncated)...');
    expect(messages[0].content.length).toBeLessThan(long.length);
  });
});
