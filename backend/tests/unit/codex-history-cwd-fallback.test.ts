import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversationService } from '../../src/services/codex-conversation';
import { CodexHistoryService } from '../../src/services/codex-history';

/**
 * The id herdr reports for a Codex pane is not always the id Codex wrote its
 * transcript under: herdr forwards the `SessionStart` hook's `session_id`, and
 * a second Codex process emitting its own `SessionStart` replaces the pane's
 * saved id (ogulcancelik/herdr#1789 — fixed on the preview channel, not in
 * 0.7.4). Both id-based routes then find nothing and the conversation reads as
 * empty, which is what these tests pin down: the cwd both sides still agree on
 * has to be enough to get back to the transcript.
 */

let scratch: string;
let sessionsDir: string;

/** A rollout as Codex writes it: `session_meta` first, then events. */
function writeRollout(opts: {
  name: string;
  sessionId: string;
  cwd: string;
  userMessage: string;
  /** Older files must sort older regardless of when the test wrote them. */
  mtime?: Date;
}): string {
  const dir = join(sessionsDir, '2026', '07', '29');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, opts.name);
  const lines = [
    {
      timestamp: '2026-07-29T14:53:35.000Z',
      type: 'session_meta',
      payload: { session_id: opts.sessionId, id: opts.sessionId, cwd: opts.cwd },
    },
    {
      timestamp: '2026-07-29T14:54:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: opts.userMessage },
    },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  if (opts.mtime) utimesSync(path, opts.mtime, opts.mtime);
  return path;
}

/** A history service whose SQLite route is always empty — the state the bug
 *  produces, since the id herdr reports is in no threads table. */
function serviceWithCwd(resolved: string | undefined): CodexHistoryService {
  const conversation = new CodexConversationService(join(scratch, 'no-such-state.sqlite'));
  return new CodexHistoryService(sessionsDir, conversation, async () => resolved);
}

describe('CodexHistoryService — cwd fallback for a herdr id Codex never wrote', () => {
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hrdle-codex-hist-'));
    sessionsDir = join(scratch, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test('an id that matches a rollout still wins — the fallback stays out of the way', async () => {
    writeRollout({
      name: 'rollout-2026-07-29T23-53-35-019fae5d-dd9c-7f40-9596-ed2c6ea6ead7.jsonl',
      sessionId: '019fae5d-dd9c-7f40-9596-ed2c6ea6ead7',
      cwd: '/home/m0a',
      userMessage: 'exact match',
    });
    // The resolver would send it somewhere else if it were ever consulted.
    const svc = serviceWithCwd('/somewhere/else');
    const messages = await svc.getConversation('019fae5d-dd9c-7f40-9596-ed2c6ea6ead7');
    expect(messages.map((m) => m.content)).toContain('exact match');
  });

  test('an id in no rollout falls back to the newest transcript in the same cwd', async () => {
    writeRollout({
      name: 'rollout-2026-07-29T20-00-00-019fae00-0000-7000-8000-000000000001.jsonl',
      sessionId: '019fae00-0000-7000-8000-000000000001',
      cwd: '/home/m0a',
      userMessage: 'older session in the same directory',
      mtime: new Date('2026-07-29T20:00:00Z'),
    });
    writeRollout({
      name: 'rollout-2026-07-29T23-53-35-019fae5d-dd9c-7f40-9596-ed2c6ea6ead7.jsonl',
      sessionId: '019fae5d-dd9c-7f40-9596-ed2c6ea6ead7',
      cwd: '/home/m0a',
      userMessage: 'the session the pane is actually running',
      mtime: new Date('2026-07-29T23:53:35Z'),
    });

    // What herdr reported: minted by a second SessionStart, in no rollout.
    const svc = serviceWithCwd('/home/m0a');
    const messages = await svc.getConversation('019fae87-b417-7453-a963-137d6ccd1cbc');

    expect(messages.map((m) => m.content)).toContain('the session the pane is actually running');
    expect(messages.map((m) => m.content)).not.toContain('older session in the same directory');
  });

  test('a rollout in a different cwd is not offered as a substitute', async () => {
    writeRollout({
      name: 'rollout-2026-07-29T23-53-35-019fae5d-dd9c-7f40-9596-ed2c6ea6ead7.jsonl',
      sessionId: '019fae5d-dd9c-7f40-9596-ed2c6ea6ead7',
      cwd: '/home/m0a/other-project',
      userMessage: 'someone else conversation',
    });
    const svc = serviceWithCwd('/home/m0a');
    expect(await svc.getConversation('019fae87-b417-7453-a963-137d6ccd1cbc')).toEqual([]);
  });

  test('herdr not knowing the id leaves the answer empty rather than arbitrary', async () => {
    writeRollout({
      name: 'rollout-2026-07-29T23-53-35-019fae5d-dd9c-7f40-9596-ed2c6ea6ead7.jsonl',
      sessionId: '019fae5d-dd9c-7f40-9596-ed2c6ea6ead7',
      cwd: '/home/m0a',
      userMessage: 'not mine to hand out',
    });
    const svc = serviceWithCwd(undefined);
    expect(await svc.getConversation('019fae87-b417-7453-a963-137d6ccd1cbc')).toEqual([]);
  });
});
