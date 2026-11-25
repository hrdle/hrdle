import { Hono } from 'hono';
import { herdrService } from '../services/session-list';
import { withControlSession } from '../services/session-input';
import { cycleToMode, parseClaudeMode } from '../services/claude-mode';
import { getPane, readPane, readPaneText, sendPaneKeys, toHerdrPaneId } from '../services/herdr-client';
import { parseClaudeProgress } from '../services/claude-progress';
import { parseClaudeSuggestion } from '../services/claude-suggestion';
import { parseClaudePanel } from '../services/claude-panel';
import { listSlashCommands } from '../services/slash-commands';
import { z } from 'zod';
import { PaneIdSchema, TabIdSchema } from '../../../shared/types';
import { findSessionByAddress } from '../services/herdr';
import { captureViewportHerdr, type HerdrControlSession } from '../services/herdr-control';
import { pushSessionsNow } from './terminal-mux';
import { forwardToPeer, parsePeerSessionId, peerSessionPath } from '../services/peer-sessions';
import { detectPaneState, stripAnsi, type DetectedPaneState } from '../services/pane-state';
import { executeAnswer, planAnswer, publicRead, readStructuredQuestion, SETTLE_MS, type PaneSnapshot } from '../services/pane-question';

/**
 * Capture a pane viewport for peer-dialog tooling (hrdle send --wait, peek).
 * Returns the trailing `lines` rows (0 = all), with both ANSI-preserved and
 * stripped variants plus a heuristic `detectedState`.
 */
async function captureViewportSnapshot(
  cs: HerdrControlSession,
  paneId: string,
  lines: number,
): Promise<{
  paneId: string;
  cols: number;
  rows: number;
  totalLines: number;
  lines: string[];
  text: string;
  cursor: { x: number; y: number; visible: boolean };
  detectedState: DetectedPaneState;
} | null> {
  const vp = await captureViewportHerdr(cs, paneId, 0);
  if (!vp) return null;
  const slice = lines > 0 ? vp.lines.slice(-lines) : vp.lines;
  const stripped = slice.map(stripAnsi);
  return {
    paneId: vp.paneId,
    cols: vp.cols,
    rows: vp.rows,
    totalLines: vp.lines.length,
    lines: slice,
    text: stripped.join('\n'),
    cursor: vp.cursor,
    detectedState: detectPaneState(vp.lines),
  };
}

export const panes = new Hono();

// =============================================================================
// Pane Operations
// =============================================================================

const PaneFocusSchema = z.object({
  paneId: PaneIdSchema,
});

const PaneCloseSchema = z.object({
  paneId: PaneIdSchema,
});

const PaneSplitSchema = z.object({
  paneId: PaneIdSchema,
  direction: z.enum(['h', 'v']),
});

const TabSelectSchema = z.object({
  tabId: TabIdSchema,
});

const TabCloseSchema = z.object({
  tabId: TabIdSchema,
});

const PaneInputSchema = z.object({
  paneId: PaneIdSchema,
  data: z.string(),
  encoding: z.enum(['utf-8', 'base64']).optional().default('utf-8'),
  // peer-dialog helpers: if `wait` is true the response includes a viewport
  // snapshot captured `waitMs` after the input is delivered. `lines` is how
  // many trailing rows to return (0 = all). Defaults match the CLI defaults.
  wait: z.boolean().optional().default(false),
  waitMs: z.number().int().min(0).max(10000).optional().default(800),
  lines: z.number().int().min(0).max(500).optional().default(20),
});

// POST /sessions/:id/panes/focus - Focus a specific pane
panes.post('/:id/panes/focus', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = PaneFocusSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    await withControlSession(id, (cs) => cs.selectPane(parsed.data.paneId));
    herdrService.invalidateCache();
    pushSessionsNow();
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to focus pane' }, 500);
  }
});

// POST /sessions/:id/panes/close - Close a specific pane
panes.post('/:id/panes/close', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = PaneCloseSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    // rejects the last pane itself
    await withControlSession(id, (cs) => cs.closePane(parsed.data.paneId));
    herdrService.invalidateCache();
    pushSessionsNow();
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to close pane';
    const status = message.includes('last pane') ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

// POST /sessions/:id/panes/split - Split a pane
panes.post('/:id/panes/split', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = PaneSplitSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    await withControlSession(id, (cs) => cs.splitPane(parsed.data.paneId, parsed.data.direction));
    herdrService.invalidateCache();
    pushSessionsNow();
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to split pane' }, 500);
  }
});

// POST /sessions/:id/tabs/select - Switch the workspace's active tab
panes.post('/:id/tabs/select', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = TabSelectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid tab ID' }, 400);
  }
  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }
  try {
    await withControlSession(id, (cs) => cs.selectTab(parsed.data.tabId));
    herdrService.invalidateCache();
    pushSessionsNow();
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to select tab' }, 500);
  }
});

// POST /sessions/:id/tabs/create - Create and switch to a new tab
panes.post('/:id/tabs/create', async (c) => {
  const id = c.req.param('id');
  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }
  try {
    await withControlSession(id, (cs) => cs.createTab());
    herdrService.invalidateCache();
    pushSessionsNow();
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to create tab' }, 500);
  }
});

// POST /sessions/:id/tabs/close - Close a tab (and its panes)
panes.post('/:id/tabs/close', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = TabCloseSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid tab ID' }, 400);
  }
  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }
  try {
    await withControlSession(id, (cs) => cs.closeTab(parsed.data.tabId));
    herdrService.invalidateCache();
    pushSessionsNow();
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to close tab' }, 500);
  }
});

// POST /sessions/:id/panes/input - Send raw input bytes to a specific pane
panes.post('/:id/panes/input', async (c) => {
  const id = c.req.param('id');
  // As for /prompt: the paneId is the peer's own value and travels untouched.
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, '/panes/input'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await c.req.text(),
    });
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = PaneInputSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  // Same as /prompt: this delivers keystrokes, so an ambiguous name says so.
  const status = await herdrService.addressStatus(id);
  if (status !== 'ok') {
    return c.json(
      status === 'ambiguous'
        ? { error: `"${id}" names more than one session - address it by session id` }
        : { error: 'Session not found' },
      404,
    );
  }

  try {
    return await withControlSession(id, async (controlSession) => {
      // A pane in another tab is still a live agent; bring it into view rather
      // than refusing to answer it.
      await controlSession.ensurePaneReachable(parsed.data.paneId);
      const panes = await controlSession.listPanes();
      const targetPane = panes.find((p) => p.paneId === parsed.data.paneId);
      if (!targetPane) {
        return c.json({ error: 'Pane not found' }, 404);
      }

      const buffer = parsed.data.encoding === 'base64'
        ? Buffer.from(parsed.data.data, 'base64')
        : Buffer.from(parsed.data.data, 'utf-8');
      await controlSession.sendInput(parsed.data.paneId, buffer);

      if (!parsed.data.wait) {
        return c.json({ success: true, paneId: parsed.data.paneId, bytes: buffer.length });
      }

      // Give the TUI time to render before snapshotting.
      if (parsed.data.waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, parsed.data.waitMs));
      }
      const viewport = await captureViewportSnapshot(controlSession, parsed.data.paneId, parsed.data.lines);
      return c.json({
        success: true,
        paneId: parsed.data.paneId,
        bytes: buffer.length,
        viewport,
      });
    });
  } catch (_error) {
    return c.json({ error: 'Failed to send input' }, 500);
  }
});

// GET /sessions/:id/panes/:paneId/viewport - Snapshot a pane's current viewport
panes.get('/:id/panes/:paneId/viewport', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const linesParam = c.req.query('lines');
  const lines = linesParam ? Math.max(0, Math.min(500, Number.parseInt(linesParam, 10) || 0)) : 20;

  if (!paneId.startsWith('%')) {
    return c.json({ error: 'paneId must start with %' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    return await withControlSession(id, async (controlSession) => {
      const panes = await controlSession.listPanes();
      if (!panes.find((p) => p.paneId === paneId)) {
        return c.json({ error: 'Pane not found' }, 404);
      }
      const viewport = await captureViewportSnapshot(controlSession, paneId, lines);
      if (!viewport) {
        return c.json({ error: 'Failed to capture viewport' }, 500);
      }
      return c.json(viewport);
    });
  } catch (_error) {
    return c.json({ error: 'Failed to capture viewport' }, 500);
  }
});

/**
 * The pane as the question reader needs it, or why it cannot be had. Read
 * fresh each time: the answer path calls it again after keys have landed, and
 * the screen is what changed.
 */
async function questionSnapshot(
  id: string,
  paneId: string,
): Promise<{ snapshot: PaneSnapshot } | { error: string; status: 404 }> {
  const { session: ws, ambiguous } = findSessionByAddress(await herdrService.listWorkspaces(), id);
  if (!ws) {
    return {
      error: ambiguous ? `"${id}" names more than one session - address it by session id` : 'Session not found',
      status: 404,
    };
  }
  const pane = ws.panes?.find((p) => p.paneId === paneId);
  if (!pane || !ws.instanceId) return { error: 'Pane not found', status: 404 };
  // More than the glasses' 30: a picker whose options carry descriptions can
  // push its own chip out of a shorter window, and without the chip there is
  // no picker.
  const text = await readPaneText(toHerdrPaneId(ws.instanceId, paneId), 'recent', 60);
  return {
    snapshot: {
      agent: pane.agent,
      agentSessionId: pane.agentSessionId,
      agentStatus: pane.agentStatus,
      text,
    },
  };
}

// GET /sessions/:id/panes/:paneId/question - The question the pane is waiting on
panes.get('/:id/panes/:paneId/question', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, `/panes/${encodeURIComponent(paneId)}/question`));
  }
  if (!PaneIdSchema.safeParse(paneId).success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }
  const got = await questionSnapshot(id, paneId);
  if ('error' in got) return c.json({ error: got.error }, got.status);
  return c.json(publicRead(await readStructuredQuestion(got.snapshot)));
});

const AnswerBodySchema = z.object({
  questionId: z.string().min(1).max(64),
  choices: z.array(z.number().int().min(0)).min(1).max(32),
  text: z.string().max(4000).optional(),
});

// POST /sessions/:id/panes/:paneId/answer - Answer the question the pane is waiting on
panes.post('/:id/panes/:paneId/answer', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, `/panes/${encodeURIComponent(paneId)}/answer`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await c.req.text(),
    });
  }
  if (!PaneIdSchema.safeParse(paneId).success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }
  const parsed = AnswerBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const got = await questionSnapshot(id, paneId);
  if ('error' in got) return c.json({ error: got.error }, got.status);
  // Read again here rather than trusting what the caller saw: the questionId
  // is checked against the pane as it is now.
  const read = await readStructuredQuestion(got.snapshot);
  const plan = planAnswer(read, parsed.data);
  if (!plan.ok) return c.json({ error: plan.error, current: publicRead(read) }, plan.status);

  const reread = async () => {
    const again = await questionSnapshot(id, paneId);
    return 'error' in again ? ({ status: 'none' } as const) : readStructuredQuestion(again.snapshot);
  };
  try {
    const result = await withControlSession(id, async (cs) => {
      await cs.ensurePaneReachable(paneId);
      return executeAnswer(plan.steps, {
        write: (data) => cs.sendInput(paneId, Buffer.from(data, 'utf-8')),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        reread,
      });
    });
    if (!result.ok) return c.json({ error: result.error }, 409);
  } catch (_error) {
    return c.json({ error: 'Failed to send answer' }, 500);
  }

  // What the pane shows now: the call's next question, the review screen, or
  // nothing - the caller answers again or is done.
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return c.json({ success: true, next: publicRead(await reread()) });
});

// POST /sessions/:id/prompt - Send a prompt text to the session's active pane.
// Optional `paneId` targets a specific pane (glasses relay reply routing):
// in a multi-pane workspace the blocked pane is not necessarily the active one.
/**
 * A path is pasted into the pane as it is, so it may not carry anything a
 * terminal would act on - a newline would submit, an escape would end the
 * paste early.
 */
const PastedPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => p.startsWith('/') && ![...p].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f), 'Invalid image path');

export const PanePromptSchema = z
  .object({
    text: z.string().default(''),
    images: z.array(PastedPathSchema).max(10).default([]),
  })
  .refine((b) => b.text.trim().length > 0 || b.images.length > 0, 'text or images is required');

/**
 * The keys the chat view presses for its controls. A closed set: the route
 * reaches any pane, and an open one would be a second, unreviewed way to type
 * into it.
 */
export const PaneKeysSchema = z.object({
  // Esc is the stop button; the arrows and Enter move through a panel Claude
  // Code draws over its input box (`/usage`, `/model`, `/config`).
  keys: z.array(z.enum(['esc', 'up', 'down', 'left', 'right', 'enter'])).min(1).max(8),
});

// POST /sessions/:id/panes/:paneId/keys - Press control keys in one pane
// The chat view's stop button.
panes.post('/:id/panes/:paneId/keys', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, `/panes/${encodeURIComponent(paneId)}/keys`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await c.req.text(),
    });
  }
  if (!PaneIdSchema.safeParse(paneId).success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }
  const parsed = PaneKeysSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400);
  }
  const status = await herdrService.addressStatus(id);
  if (status !== 'ok') {
    return c.json(
      status === 'ambiguous'
        ? { error: `"${id}" names more than one session - address it by session id` }
        : { error: 'Session not found' },
      404,
    );
  }
  try {
    const result = await herdrService.pressPaneKeys(id, paneId, parsed.data.keys);
    if (result === 'missing') return c.json({ error: 'Session not found' }, 404);
    return c.json({ success: true, paneId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: `The pane did not take the keys: ${message}` }, 409);
  }
});

const PaneModeSchema = z.object({
  // Bypass is left out: the chat view does not offer it, as the Claude app does not.
  mode: z.enum(['manual', 'acceptEdits', 'plan', 'auto']),
});

// GET /sessions/:id/panes/:paneId/mode - Claude Code's permission mode, read off its footer
panes.get('/:id/panes/:paneId/mode', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, `/panes/${encodeURIComponent(paneId)}/mode`));
  }
  if (!PaneIdSchema.safeParse(paneId).success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }
  const target = await herdrService.herdrPaneOf(id, paneId);
  if (!target) return c.json({ error: 'Session not found' }, 404);
  const screen = await readPaneText(target, 'visible');
  return c.json({ mode: screen ? parseClaudeMode(screen) : null });
});

// GET /sessions/:id/panes/:paneId/suggestion - The next prompt Claude Code
// suggests, read off its input box
panes.get('/:id/panes/:paneId/suggestion', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, `/panes/${encodeURIComponent(paneId)}/suggestion`));
  }
  if (!PaneIdSchema.safeParse(paneId).success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }
  const target = await herdrService.herdrPaneOf(id, paneId);
  if (!target) return c.json({ error: 'Session not found' }, 404);
  const screen = await readPane(target, 'visible');
  return c.json({ suggestion: screen ? parseClaudeSuggestion(screen) : null });
});

// GET /sessions/:id/panes/:paneId/progress - The line Claude Code draws above
// its input box while a turn runs (verb, elapsed time, tokens)
panes.get('/:id/panes/:paneId/progress', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, `/panes/${encodeURIComponent(paneId)}/progress`));
  }
  if (!PaneIdSchema.safeParse(paneId).success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }
  const target = await herdrService.herdrPaneOf(id, paneId);
  if (!target) return c.json({ error: 'Session not found' }, 404);
  const screen = await readPaneText(target, 'visible');
  return c.json({ progress: screen ? parseClaudeProgress(screen) : null });
});

// GET /sessions/:id/panes/:paneId/panel - A panel Claude Code draws over its
// input box (`/usage`, `/model`, `/config`), as text
panes.get('/:id/panes/:paneId/panel', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, `/panes/${encodeURIComponent(paneId)}/panel`));
  }
  if (!PaneIdSchema.safeParse(paneId).success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }
  const target = await herdrService.herdrPaneOf(id, paneId);
  if (!target) return c.json({ error: 'Session not found' }, 404);
  const screen = await readPaneText(target, 'visible');
  return c.json({ panel: screen ? parseClaudePanel(screen) : null });
});

// POST /sessions/:id/panes/:paneId/mode - Cycle to a mode with Shift+Tab
panes.post('/:id/panes/:paneId/mode', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, `/panes/${encodeURIComponent(paneId)}/mode`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await c.req.text(),
    });
  }
  if (!PaneIdSchema.safeParse(paneId).success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }
  const parsed = PaneModeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400);
  }
  const target = await herdrService.herdrPaneOf(id, paneId);
  if (!target) return c.json({ error: 'Session not found' }, 404);
  const result = await cycleToMode(parsed.data.mode, {
    read: () => readPaneText(target, 'visible'),
    pressShiftTab: () => sendPaneKeys(target, ['shift+tab']),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  if (!result.ok) return c.json({ error: result.error, mode: result.mode }, 409);
  return c.json({ mode: result.mode });
});

// GET /sessions/:id/panes/:paneId/commands - The person's own slash commands
// and skills for the pane's project, for the chat view's palette
panes.get('/:id/panes/:paneId/commands', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, `/panes/${encodeURIComponent(paneId)}/commands`));
  }
  if (!PaneIdSchema.safeParse(paneId).success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }
  const target = await herdrService.herdrPaneOf(id, paneId);
  if (!target) return c.json({ error: 'Session not found' }, 404);
  const pane = await getPane(target);
  // The pane's own directory: the agent reads `.claude` from where it was
  // started, and the foreground directory moves with every `cd` in a shell.
  return c.json({ commands: await listSlashCommands(pane?.cwd ?? null) });
});

// POST /sessions/:id/panes/:paneId/prompt - Submit a prompt to one pane's agent
// The chat view's composer. Unlike /prompt it names the pane - a workspace can
// hold two agents - and goes through herdr's agent.prompt rather than a pane
// control stream.
panes.post('/:id/panes/:paneId/prompt', async (c) => {
  const id = c.req.param('id');
  const paneId = c.req.param('paneId');
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, `/panes/${encodeURIComponent(paneId)}/prompt`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await c.req.text(),
    });
  }
  if (!PaneIdSchema.safeParse(paneId).success) {
    return c.json({ error: 'Invalid pane ID' }, 400);
  }
  const parsed = PanePromptSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400);
  }
  const { text, images } = parsed.data;

  const status = await herdrService.addressStatus(id);
  if (status !== 'ok') {
    return c.json(
      status === 'ambiguous'
        ? { error: `"${id}" names more than one session - address it by session id` }
        : { error: 'Session not found' },
      404,
    );
  }

  try {
    const result = await herdrService.promptPane(id, paneId, text, images);
    if (result === 'missing') return c.json({ error: 'Session not found' }, 404);
    if (result === 'no-agent') return c.json({ error: 'No agent is running in this pane' }, 409);
    return c.json({ success: true, paneId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: `The pane's agent did not take the prompt: ${message}` }, 409);
  }
});
