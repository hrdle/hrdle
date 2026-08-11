import { describe, expect, test } from 'bun:test';
import { MuxClientMessageSchema } from '../../../../shared/types';

/**
 * Incoming /ws/mux control frames are validated by MuxClientMessageSchema and
 * SILENTLY DROPPED on failure (terminal-mux.ts). A field the schema doesn't
 * list is stripped (zod default). Two regressions this locks:
 *   - `pane-demands` must be a known variant, or per-client sizing reports
 *     never reach the server.
 *   - `zoom-pane.zoomed` must be in the schema, or the explicit zoom/unzoom
 *     intent is stripped and the server silently falls back to toggle.
 */
describe('MuxClientMessageSchema — pane-demands', () => {
  test('accepts pane-demands and keeps the demands', () => {
    const r = MuxClientMessageSchema.safeParse({
      type: 'pane-demands',
      sessionId: 's',
      demands: { '%1': { cols: 50, rows: 45 } },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'pane-demands') {
      expect(r.data.demands['%1']).toEqual({ cols: 50, rows: 45 });
    }
  });

  test('rejects a non-pane key', () => {
    const r = MuxClientMessageSchema.safeParse({
      type: 'pane-demands',
      sessionId: 's',
      demands: { notapane: { cols: 50, rows: 45 } },
    });
    expect(r.success).toBe(false);
  });

  test('rejects out-of-range dimensions', () => {
    const r = MuxClientMessageSchema.safeParse({
      type: 'pane-demands',
      sessionId: 's',
      demands: { '%1': { cols: 0, rows: 45 } },
    });
    expect(r.success).toBe(false);
  });

  test('caps the number of demanded panes', () => {
    const demands: Record<string, { cols: number; rows: number }> = {};
    for (let i = 0; i < 65; i++) demands[`%${i}`] = { cols: 80, rows: 24 };
    const r = MuxClientMessageSchema.safeParse({ type: 'pane-demands', sessionId: 's', demands });
    expect(r.success).toBe(false);
  });
});

describe('MuxClientMessageSchema — zoom-pane', () => {
  test('retains the explicit zoomed flag (not stripped)', () => {
    const r = MuxClientMessageSchema.safeParse({
      type: 'zoom-pane',
      sessionId: 's',
      paneId: '%1',
      zoomed: true,
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'zoom-pane') {
      expect(r.data.zoomed).toBe(true);
    }
  });

  test('still valid without zoomed (toggle fallback)', () => {
    const r = MuxClientMessageSchema.safeParse({ type: 'zoom-pane', sessionId: 's', paneId: '%1' });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'zoom-pane') {
      expect(r.data.zoomed).toBeUndefined();
    }
  });
});

describe('MuxClientMessageSchema — glasses-relay subscription', () => {
  test('accepts subscribe/unsubscribe-glasses-relay with no sessionId', () => {
    expect(MuxClientMessageSchema.safeParse({ type: 'subscribe-glasses-relay' }).success).toBe(true);
    expect(MuxClientMessageSchema.safeParse({ type: 'unsubscribe-glasses-relay' }).success).toBe(
      true,
    );
  });

  test('extra keys are stripped, unknown types rejected', () => {
    const r = MuxClientMessageSchema.safeParse({ type: 'subscribe-glasses-relay', sessionId: 's' });
    expect(r.success).toBe(true);
    if (r.success) expect('sessionId' in r.data).toBe(false);
    expect(MuxClientMessageSchema.safeParse({ type: 'glasses-relay' }).success).toBe(false);
  });
});

describe('MuxClientMessageSchema — per-pane conversation subscription', () => {
  test('keeps agentSessionId, which names which conversation of a workspace', () => {
    const r = MuxClientMessageSchema.safeParse({
      type: 'subscribe-conversation',
      sessionId: 'work',
      agentSessionId: 'aaaa-bbbb',
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'subscribe-conversation') {
      expect(r.data.agentSessionId).toBe('aaaa-bbbb');
    }
  });

  test('unsubscribe carries it too, so one pane cannot close the other watcher', () => {
    const r = MuxClientMessageSchema.safeParse({
      type: 'unsubscribe-conversation',
      sessionId: 'work',
      agentSessionId: 'aaaa-bbbb',
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'unsubscribe-conversation') {
      expect(r.data.agentSessionId).toBe('aaaa-bbbb');
    }
  });

  test('still valid without it: a single-agent workspace resolves by directory', () => {
    const r = MuxClientMessageSchema.safeParse({ type: 'subscribe-conversation', sessionId: 'work' });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'subscribe-conversation') {
      expect(r.data.agentSessionId).toBeUndefined();
    }
  });
});
