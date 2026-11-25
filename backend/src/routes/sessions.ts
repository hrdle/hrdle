import { Hono } from 'hono';
import { panes } from './panes';
import { sessionHistory } from './session-history';
import { buildSessionsList, herdrService, isUnseen, sessionIndicatorOf, sessionStateOf } from '../services/session-list';
import { sendTextToSession } from '../services/session-input';
import { expandHome } from '../utils/shell';
import { promptAgent, startAgent, waitForAgentReady, type StartedAgent } from '../services/agent-launch';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { AGENT_PROVIDER_IDS, CreateSessionSchema, DEFAULT_AGENT_PROVIDER, PaneIdSchema, SessionIdSchema, agentResumeCommand, type AgentLaunchReport, type AgentProvider } from '../../../shared/types';
import { findSessionByAddress } from '../services/herdr';
import { setSessionTheme, setSessionSttPrompt, setSessionSttGlossary, addSessionSttTerms, removeLastKnownSession } from '../services/session-metadata';
import { STT_PROMPT_MAX_CHARS, seedWorkspaceVocabulary, sessionPromptTerms } from '../services/stt-prompt';
import { getIndicatorOverride } from './notify';
import { pushSessionsNow } from './terminal-mux';
import { forwardToPeer, parsePeerSessionId, peerSessionPath, sessionsWithPeers } from '../services/peer-sessions';

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export const sessions = new Hono();

// Before the `/:id` routes, which would otherwise take `/history` as an id.
sessions.route('/', sessionHistory);

const ResumeSessionSchema = z.object({
  ccSessionId: SessionIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
  agent: z.enum(AGENT_PROVIDER_IDS).optional(),
});

// GET /sessions - List all sessions (debug/fallback only, frontend uses WS push)
sessions.get('/', async (c) => {
  const sessionsList = await buildSessionsList();
  // The glasses learn the list from here and from the WebSocket push and from
  // nowhere else, so the peers' sessions are merged in by default (see
  // services/peer-sessions.ts). `?local=1` is the promise to answer with this
  // server's own sessions only, which is what the peers' fanout asks for: a
  // merged answer would hand a peer its own sessions back.
  if (c.req.query('local') === '1') {
    return c.json({ sessions: sessionsList });
  }
  return c.json({ sessions: await sessionsWithPeers(sessionsList) });
});

// POST /sessions - Create a new session
sessions.post('/', async (c) => {
  pushSessionsNow();
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateSessionSchema.safeParse(body);
  // A body that does not validate is refused, not defaulted. Falling back
  // field by field dropped the name, the directory and the agent together,
  // and answered 201 with a bare shell under `session-N`: the caller had no
  // way to tell, and its next prompt ran as a shell command.
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.issues }, 400);
  }
  const { agent, workingDir, initialPrompt, wait } = parsed.data;

  const herdrSessions = await herdrService.listWorkspaces();
  // The label is free text and need not be unique: a session is addressed by
  // its workspace id, and herdr allows two workspaces the same label.
  const name = parsed.data.name ?? `session-${herdrSessions.length + 1}`;

  const cwd = workingDir ? expandHome(workingDir) : undefined;
  if (cwd && !(await isDirectory(cwd))) {
    return c.json({ error: 'working_dir_not_found', workingDir }, 400);
  }

  let created: { workspaceId: string; rootPaneId?: string };
  try {
    created = await herdrService.createWorkspaceWithRoot(name, cwd);
  } catch (_error) {
    return c.json({ error: 'Failed to create session' }, 500);
  }
  const instanceId = created.workspaceId;

  // A new workspace takes a copy of the glossary and stops sharing: from
  // here its vocabulary is one list it owns, and terms it will never say
  // can be deleted. Best-effort - a workspace with no vocabulary of its own
  // falls back to the shared glossary, so failing here costs nothing.
  await seedWorkspaceVocabulary(instanceId).catch(() => {});

  // The workspace exists from here on, so an agent that fails to come up is
  // reported in the 201 rather than as an error: the caller has a workspace
  // either way and needs its id.
  const launch: AgentLaunchReport = {};

  if (cwd) {
    let started: StartedAgent | undefined;
    try {
      if (!created.rootPaneId) throw new Error('herdr workspace.create returned no root pane');
      started = await startAgent({ paneId: created.rootPaneId, kind: agent });
      launch.agentName = started.name;
    } catch (err) {
      launch.agentReady = false;
      launch.agentError = { code: 'start_failed', message: (err as Error).message };
    }

    if (started) {
      const agentRef = { ...started, kind: agent };
      const readyThenPrompt = async () => {
        const result = await waitForAgentReady(agentRef);
        if (!result.ready || !initialPrompt || result.blocked) return { result, promptSent: false };
        await promptAgent(agentRef.name, initialPrompt);
        return { result, promptSent: true };
      };
      const blockedError = {
        code: 'blocked',
        message: 'the agent is asking a question first, so the initial prompt was not sent',
      };

      if (wait) {
        try {
          const { result, promptSent } = await readyThenPrompt();
          launch.agentReady = result.ready;
          if (!result.ready) launch.agentError = { code: result.code, message: result.message };
          else if (initialPrompt && result.blocked) launch.agentError = blockedError;
          if (initialPrompt) launch.promptSent = promptSent;
        } catch (err) {
          // Ready, but the prompt did not go through.
          launch.agentReady = true;
          launch.promptSent = false;
          launch.agentError = { code: 'prompt_failed', message: (err as Error).message };
        }
      } else if (initialPrompt) {
        readyThenPrompt()
          .then(({ result }) => {
            const why = !result.ready ? result : result.blocked ? blockedError : null;
            if (why) {
              console.warn(`[sessions] initial prompt not sent for ${instanceId}: ${why.code} ${why.message}`);
            }
          })
          .catch((err) => {
            console.warn(`[sessions] initial prompt delivery failed for ${instanceId}:`, err);
          });
      }
    }
  }

  // The id is herdr's workspace id, the same value the list answers with.
  // Handing back the label instead leaves the caller holding an id that
  // matches nothing in `GET /sessions`, and the frontend persists it into
  // the pane tree — so the desktop comes back from a reload with a session
  // it cannot resolve.
  return c.json({
    id: instanceId,
    name,
    instanceId,
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    state: 'idle',
    agent,
    ...launch,
  }, 201);
});

// GET /sessions/:id - Get a specific session
sessions.get('/:id', async (c) => {
  const id = c.req.param('id');
  const herdrSessions = await herdrService.listWorkspaces();
  // By id, then by name - the same two ways every other route accepts, and
  // for the same reason: a name is what a person types and what an
  // older client still holds. An ambiguous name resolves to nothing rather
  // than to whichever workspace happens to sort first.
  const { session, ambiguous } = findSessionByAddress(herdrSessions, id);

  if (!session) {
    return c.json({ error: ambiguous ? 'Ambiguous session name' : 'Session not found' }, 404);
  }

  const agentSessionId = session.agentSessionId;
  const indicatorState = sessionIndicatorOf(
    session.agent ?? session.currentCommand,
    session.agentStatus,
    agentSessionId ? (getIndicatorOverride(agentSessionId)?.state ?? null) : null,
  );

  return c.json({
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    lastAccessedAt: session.createdAt,
    state: sessionStateOf(indicatorState),
    indicatorState,
    unseen: isUnseen(session.agentStatus),
    currentCommand: session.currentCommand,
    agent: session.agent,
    currentPath: session.currentPath,
  });
});

// DELETE /sessions/:id - Delete (kill) a session
sessions.delete('/:id', async (c) => {
  pushSessionsNow();
  const id = c.req.param('id');

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    // Already lost — purge from last-known so it disappears from the list.
    await removeLastKnownSession(id).catch(() => {});
    return c.json({ success: true });
  }

  try {
    await herdrService.killWorkspace(id);
    // Keep the entry in last-known so the session shows up as "Lost" and can
    // be resumed via the Resume button without going to the history tab.
    // To purge entirely, delete the Lost session again.
    return c.json({ success: true });
  } catch (_error) {
    return c.json({ error: 'Failed to delete session' }, 500);
  }
});

// POST /sessions/:id/resume - Resume an agent session in an existing session
sessions.post('/:id/resume', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = ResumeSessionSchema.safeParse(body);

  const herdrSessions = await herdrService.listWorkspaces();
  const { session, ambiguous } = findSessionByAddress(herdrSessions, id);
  if (!session) {
    return c.json({ error: ambiguous ? 'Ambiguous session name' : 'Session not found' }, 404);
  }

  try {
    const sessionId = parsed.success ? (parsed.data.sessionId ?? parsed.data.ccSessionId) : undefined;
    const requestedAgent = parsed.success ? parsed.data.agent : undefined;
    const agent: AgentProvider = requestedAgent ?? session.agent ?? DEFAULT_AGENT_PROVIDER;
    const command = agentResumeCommand(agent, sessionId);

    await sendTextToSession(id, command);

    return c.json({ success: true, command });
  } catch (_error) {
    return c.json({ error: 'Failed to resume session' }, 500);
  }
});

// PUT /sessions/:id/theme - Update session theme color
const UpdateThemeSchema = z.object({
  theme: z.enum(['red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink']).nullable(),
});

sessions.put('/:id/theme', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateThemeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid theme' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    await setSessionTheme(id, parsed.data.theme);
    return c.json({ success: true, theme: parsed.data.theme });
  } catch (_error) {
    return c.json({ error: 'Failed to update theme' }, 500);
  }
});

// PUT /sessions/:id/title - Rename the session's herdr workspace. The name
// lives in herdr (workspace label), not in an hrdle-side store — same rule as
// the display order. The label is *not* the session id, so a rename
// changes what it is called and nothing about how it is reached.
const UpdateTitleSchema = z.object({
  title: z.string().max(100).nullable(),
});

sessions.put('/:id/title', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateTitleSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid title' }, 400);
  }
  const title = parsed.data.title?.trim();
  if (!title) {
    return c.json({ error: 'Title must not be empty' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    // The id does not change with the name, so nothing is rekeyed and
    // nothing has to switch addresses, which is the whole point: a rename
    // must not retire the session's address mid-conversation.
    const sessionId = await herdrService.renameWorkspace(id, title);
    return c.json({ success: true, title, id: sessionId });
  } catch (_error) {
    return c.json({ error: 'Failed to update title' }, 500);
  }
});

// PUT /sessions/:id/stt-prompt - Words this session's speech is made of.
//
// Kept short deliberately: Whisper's prompt is capped at 224 tokens and this
// group leads the composition, so a long one would push out the glossary it is
// meant to sit in front of. 100 rather than the 200 it started at, because the
// composition now hard-limits the contributed groups to half its budget
// and a field that accepts twice what can be used is a field that silently
// drops the rest.
// The cap is the whole prompt line, not half of it: a workspace that has
// declined the glossary has the whole budget, and a stored value cut shorter
// than what composition would take is a second, invisible limit.
const UpdateSttPromptSchema = z.object({
  sttPrompt: z.string().max(STT_PROMPT_MAX_CHARS).nullable().optional(),
  /** Add to what is there instead of replacing it. */
  add: z.string().max(STT_PROMPT_MAX_CHARS).optional(),
  glossary: z.boolean().optional(),
});

sessions.put('/:id/stt-prompt', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateSttPromptSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid STT prompt' }, 400);
  }

  const exists = await herdrService.workspaceExists(id);
  if (!exists) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    if (parsed.data.sttPrompt !== undefined) {
      await setSessionSttPrompt(id, parsed.data.sttPrompt);
    }
    if (parsed.data.glossary !== undefined) {
      await setSessionSttGlossary(id, parsed.data.glossary);
    }
    if (parsed.data.add !== undefined) {
      const result = await addSessionSttTerms(
        id,
        sessionPromptTerms(parsed.data.add),
        STT_PROMPT_MAX_CHARS,
      );
      if (!result.ok) {
        return c.json(
          { error: 'too_long', wouldBe: result.wouldBe, max: STT_PROMPT_MAX_CHARS, sttPrompt: result.stored },
          400,
        );
      }
      return c.json({ success: true, sttPrompt: result.stored, added: result.added, duplicate: result.duplicate });
    }
    return c.json({ success: true, sttPrompt: parsed.data.sttPrompt });
  } catch (_error) {
    return c.json({ error: 'Failed to update STT prompt' }, 500);
  }
});

// POST /sessions/:id/move - Move a session to `index` in the display order.
// The order lives in herdr (workspace order), not in hrdle — so this is a
// write straight through to herdr rather than to a hrdle-side store.
sessions.post('/:id/move', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const index = (body as { index?: unknown }).index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    return c.json({ error: 'Invalid index' }, 400);
  }
  try {
    const moved = await herdrService.moveWorkspace(id, index);
    if (!moved) return c.json({ error: 'Session not found' }, 404);
    pushSessionsNow();
    return c.json({ success: true });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Failed to move session' },
      500,
    );
  }
});

sessions.route('/', panes);

sessions.post('/:id/prompt', async (c) => {
  const id = c.req.param('id');
  // Addressed to a peer's session, the body goes to the same endpoint on that
  // machine unread; the checks (text present, pane named) run there, in this
  // same code.
  const peerRef = parsePeerSessionId(id);
  if (peerRef) {
    return forwardToPeer(peerRef, peerSessionPath(peerRef, '/prompt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await c.req.text(),
    });
  }
  const body = await c.req.json().catch(() => ({}));
  const text = body.text as string | undefined;
  const paneId = body.paneId as string | undefined;

  if (!text) {
    return c.json({ error: 'text is required' }, 400);
  }
  if (paneId !== undefined) {
    const parsed = PaneIdSchema.safeParse(paneId);
    if (!parsed.success) {
      return c.json({ error: 'Invalid pane ID' }, 400);
    }
  }

  // The delivery paths say *why* nothing was reached: a name that now points at
  // two workspaces has to be answered differently from one that points at none
  //, because only one of them is fixed by saying which session.
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
    // Bracketed paste + separately-delivered \r (see sendTextToSession)
    const targetPaneId = await sendTextToSession(id, text, { bracketed: true, paneId });
    return c.json({ success: true, paneId: targetPaneId });
  } catch (error) {
    if (error instanceof Error && error.message === 'Pane not found') {
      return c.json({ error: 'Pane not found' }, 404);
    }
    return c.json({ error: 'Failed to send prompt' }, 500);
  }
});
