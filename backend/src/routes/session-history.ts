import { Hono } from 'hono';
import { claudeCodeService, herdrService } from '../services/session-list';
import { sendTextToSession } from '../services/session-input';
import { expandHome, shellQuote } from '../utils/shell';
import { z } from 'zod';
import { AGENT_PROVIDER_IDS, DEFAULT_AGENT_PROVIDER, SessionIdSchema, agentResumeCommand, isAgentProvider, type AgentProvider } from '../../../shared/types';
import { CodexConversationService } from '../services/codex-conversation';
import { SessionHistoryService } from '../services/session-history';
import { CodexHistoryService } from '../services/codex-history';
import { GrokHistoryService } from '../services/grok-history';
import { KimiHistoryService } from '../services/kimi-history';
import { OpenCodeHistoryService } from '../services/opencode-history';
import { PiHistoryService } from '../services/pi-history';
import type { AgentHistoryProvider } from '../services/agent-providers';
import { PromptHistoryService } from '../services/prompt-history';
import { forwardToPeer, parsePeerSessionId } from '../services/peer-sessions';

const codexConversationService = new CodexConversationService();
export const sessionHistoryService = new SessionHistoryService();

export const agentHistoryProviders: Partial<Record<AgentProvider, AgentHistoryProvider>> = {
  codex: new CodexHistoryService(undefined, codexConversationService),
  grok: new GrokHistoryService(),
  kimi: new KimiHistoryService(),
  opencode: new OpenCodeHistoryService(),
  pi: new PiHistoryService(),
};
const promptHistoryService = new PromptHistoryService();

export function findWorkspaceRunningConversation<
  T extends { agentSessionId?: string; panes?: Array<{ agentSessionId?: string }> },
>(sessions: T[], agentSessionId: string): T | undefined {
  return sessions.find(
    (s) => s.agentSessionId === agentSessionId || s.panes?.some((p) => p.agentSessionId === agentSessionId),
  );
}

export const sessionHistory = new Hono();

// GET /sessions/history/projects - Get list of projects (fast, no file content reading)
// Merges Claude (~/.claude/projects/*) and every thread agent's buckets
// (Codex rollouts, Grok sessions, ...) by encoded cwd so the same directory
// shows up once.
sessionHistory.get('/history/projects', async (c) => {
  const [claudeProjects, ...agentProjects] = await Promise.all([
    sessionHistoryService.getProjects(),
    ...Object.values(agentHistoryProviders).map(p => p.getProjects()),
  ]);
  const byDir = new Map<string, typeof claudeProjects[number]>();
  for (const p of claudeProjects) byDir.set(p.dirName, p);
  for (const p of agentProjects.flat()) {
    const existing = byDir.get(p.dirName);
    if (existing) {
      existing.sessionCount += p.sessionCount;
      if (!existing.latestModified || (p.latestModified && p.latestModified > existing.latestModified)) {
        existing.latestModified = p.latestModified;
      }
    } else {
      byDir.set(p.dirName, p);
    }
  }
  const projects = Array.from(byDir.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
  return c.json({ projects });
});

// GET /sessions/history/search - Search sessions across all projects
sessionHistory.get('/history/search', async (c) => {
  const query = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const [claudeMatches, ...agentMatches] = await Promise.all([
    sessionHistoryService.searchSessions(query, limit),
    ...Object.values(agentHistoryProviders).map(p => p.searchSessions(query, limit)),
  ]);
  const merged = [
    ...claudeMatches.map(s => ({ ...s, agent: s.agent ?? 'claude' as const })),
    ...agentMatches.flat(),
  ].sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()).slice(0, limit);
  return c.json({ sessions: merged });
});

// GET /sessions/history/search/stream - Streaming search with SSE
sessionHistory.get('/history/search/stream', async (c) => {
  const query = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '50', 10);

  // Set up SSE headers
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let yielded = 0;

      try {
        // Emit thread-agent matches up-front (small sets, scanned in one pass).
        const agentMatches = await Promise.all(
          Object.values(agentHistoryProviders).map(p => p.searchSessions(query, limit)),
        );
        for (const session of agentMatches.flat()) {
          if (yielded >= limit) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(session)}\n\n`));
          yielded++;
        }
        // Then stream Claude matches incrementally.
        for await (const session of sessionHistoryService.searchSessionsStream(query, limit - yielded)) {
          if (yielded >= limit) break;
          const tagged = { ...session, agent: session.agent ?? 'claude' as const };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(tagged)}\n\n`));
          yielded++;
        }
        // Send done event
        controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
      } catch (_error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// GET /sessions/history/projects/:dirName - Get sessions for a specific project
// Returns merged Claude + thread-agent sessions in the same project bucket.
sessionHistory.get('/history/projects/:dirName', async (c) => {
  const dirName = c.req.param('dirName');
  const [claudeSessions, ...agentSessions] = await Promise.all([
    sessionHistoryService.getProjectSessions(dirName),
    ...Object.values(agentHistoryProviders).map(p => p.getProjectSessions(dirName)),
  ]);
  const merged = [
    ...claudeSessions.map(s => ({ ...s, agent: s.agent ?? 'claude' as const })),
    ...agentSessions.flat(),
  ].sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return c.json({ sessions: merged });
});

// GET /sessions/history - Get past session history (recent across all projects)
// NOTE: This must be defined BEFORE /:id to prevent "history" being interpreted as an id
sessionHistory.get('/history', async (c) => {
  const includeMetadata = c.req.query('metadata') === 'true';
  const [claudeHistory, ...agentHistory] = await Promise.all([
    sessionHistoryService.getRecentSessions(30, includeMetadata),
    ...Object.values(agentHistoryProviders).map(p => p.getRecentSessions(30)),
  ]);
  const merged = [
    ...claudeHistory.map(s => ({ ...s, agent: s.agent ?? 'claude' as const })),
    ...agentHistory.flat(),
  ].sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()).slice(0, 30);
  return c.json({ sessions: merged });
});

// GET /sessions/history/:sessionId/conversation - Get conversation history for a session
// ?last=N returns only the last N messages (for lightweight clients like G2 glasses)
// ?agent=<provider> routes to that thread agent's reader instead of Claude's jsonl
sessionHistory.get('/history/:sessionId/conversation', async (c) => {
  const sessionId = c.req.param('sessionId');
  // A conversation exists only on the host that holds its transcript. A peer's
  // conversation id is forwarded there as it came, query and all.
  const peerRef = parsePeerSessionId(sessionId);
  if (peerRef) {
    const query = new URL(c.req.url).search;
    return forwardToPeer(
      peerRef,
      `/api/sessions/history/${encodeURIComponent(peerRef.localId)}/conversation${query}`,
    );
  }
  const projectDirName = c.req.query('projectDirName');
  const lastQuery = c.req.query('last');
  const last = lastQuery ? parseInt(lastQuery, 10) : undefined;
  const agent = c.req.query('agent');
  const provider = agent && isAgentProvider(agent) ? agentHistoryProviders[agent] : undefined;
  const messages = provider
    ? await provider.getConversation(sessionId)
    : await sessionHistoryService.getConversation(sessionId, projectDirName);
  return c.json({ messages: last ? messages.slice(-last) : messages });
});

// POST /sessions/history/metadata - Lazy load metadata for specific sessions
const MetadataRequestSchema = z.object({
  sessionIds: z.array(z.string()),
});

sessionHistory.post('/history/metadata', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = MetadataRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request: sessionIds array required' }, 400);
  }

  const { sessionIds } = parsed.data;
  const metadata = await sessionHistoryService.getSessionsMetadata(sessionIds);
  return c.json({ metadata });
});

// GET /sessions/prompts/search - Search prompt history (C1)
sessionHistory.get('/prompts/search', async (c) => {
  const query = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '20', 10);

  if (!query.trim()) {
    // Return recent prompts if no query
    const prompts = await promptHistoryService.getRecentPrompts(limit);
    return c.json({ prompts });
  }

  const prompts = await promptHistoryService.searchPrompts(query, limit);
  return c.json({ prompts });
});

// POST /sessions/history/resume - Resume a session from history (creates a new session)
// NOTE: Must be defined BEFORE /:id routes
const ResumeHistorySchema = z.object({
  sessionId: SessionIdSchema,
  projectPath: z.string(),
  agent: z.enum(AGENT_PROVIDER_IDS).optional(),
});

sessionHistory.post('/history/resume', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = ResumeHistorySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request: sessionId and projectPath required' }, 400);
  }

  const { sessionId } = parsed.data;
  const agent: AgentProvider = parsed.data.agent ?? DEFAULT_AGENT_PROVIDER;
  // The provided projectPath can be stale (lost sessions record the pane's
  // cwd, which falls back to the shell dir once the agent exits). The cwd
  // recorded inside the conversation .jsonl is authoritative — `claude -r`
  // only finds conversations from the project directory they belong to.
  const recordedCwd =
    agent === 'claude' ? await claudeCodeService.resolveSessionCwd(sessionId) : null;
  const projectPath = recordedCwd ?? parsed.data.projectPath;

  try {
    // Generate a unique session name based on project
    const projectName = projectPath.split('/').pop() || 'session';
    const herdrSessions = await herdrService.listWorkspaces();

    // The conversation is already live in a workspace: that workspace is what
    // was asked for. Resuming it again would put one conversation in two panes.
    const open = findWorkspaceRunningConversation(herdrSessions, sessionId);
    if (open) {
      return c.json({
        success: true,
        tmuxSessionId: open.id,
        name: open.name,
        ccSessionId: sessionId,
        agent,
        alreadyOpen: true,
      });
    }

    let sessionName = projectName;
    let counter = 1;
    while (herdrSessions.some(s => s.name === sessionName)) {
      sessionName = `${projectName}-${counter++}`;
    }

    // Create new session
    const workspaceId = await herdrService.createWorkspace(sessionName);

    // Change to project directory and run the agent's resume command
    const command = `cd ${shellQuote(expandHome(projectPath))} && ${agentResumeCommand(agent, sessionId)}`;
    try {
      await sendTextToSession(workspaceId, command);
    } catch {
      // Clean up the session if command failed
      await herdrService.killWorkspace(workspaceId);
      return c.json({ error: 'Failed to start agent session' }, 500);
    }

    // The id, not the label: callers look the new session up by it, and a
    // session's id is its workspace id.
    return c.json({
      success: true,
      tmuxSessionId: workspaceId,
      name: sessionName,
      ccSessionId: sessionId,
      agent,
    });
  } catch (_error) {
    return c.json({ error: 'Failed to resume session from history' }, 500);
  }
});
