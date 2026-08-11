import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  PeerCreateSchema,
  PeerUpdateSchema,
  PeerOrderSchema,
  LOCAL_PEER_ID,
  SELF_PEER_URL,
  type PeerClientView,
  type PeerStatus,
  type PeerSession,
  type PeerSessionsResponse,
  type ExtendedSessionResponse,
  type PeerHistoryProject,
  type PeerHistoryProjectsResponse,
  type HistorySession,
  isAgentProvider,
} from '../../../shared/types';
import {
  listPeers,
  createPeer,
  updatePeer,
  deletePeer,
  setPeerOrder,
  type StoredPeer,
} from '../services/peer-registry';
import { loginToPeer, verifyPeer, peerFetch, PeerAuthError } from '../services/peer-auth';
import { isSafePeerUrl } from '../services/peer-url';
import { discoverPeers } from '../services/peer-discovery';
import { buildSessionsList, sessionHistoryService, agentHistoryProviders } from './sessions';
import { getDashboard } from './dashboard';
import { saveUploadedImage } from './upload';
import type { DashboardResponse } from '../../../shared/types';

export const peers = new Hono();

function toClientView(peer: StoredPeer & {
  wsToken?: string;
  lastSeenAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
}): PeerClientView {
  const status: PeerStatus = peer.id === LOCAL_PEER_ID
    ? 'online'
    : peer.lastErrorMessage
      ? (peer.lastErrorMessage === 'unauthorized' ? 'unauthorized' : 'offline')
      : peer.lastSeenAt
        ? 'online'
        : 'unknown';

  return {
    id: peer.id,
    nickname: peer.nickname,
    url: peer.url,
    color: peer.color,
    order: peer.order,
    wsToken: peer.id === LOCAL_PEER_ID ? undefined : peer.wsToken,
    status,
    lastSeenAt: peer.lastSeenAt,
    errorMessage: peer.lastErrorMessage,
  };
}

// GET /api/peers - list peers (including self)
peers.get('/', async (c) => {
  const all = await listPeers();
  return c.json({ peers: all.map(toClientView) });
});

// GET /api/peers/discover - find peers running hrdle on the Tailscale tailnet
peers.get('/discover', async (c) => {
  const discovered = await discoverPeers();
  return c.json({ discovered });
});

// POST /api/peers - add a peer
peers.post('/', zValidator('json', PeerCreateSchema), async (c) => {
  const { nickname, url, password, color } = c.req.valid('json');

  // Always probe connectivity and log in before registering
  let token: string;
  try {
    token = await loginToPeer(url, password);
  } catch (err) {
    if (err instanceof PeerAuthError) {
      return c.json({ error: err.message, code: 'PEER_AUTH_FAILED' }, 400);
    }
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }

  const peer = await createPeer({ nickname, url, color, wsToken: token });
  return c.json({ peer: toClientView(peer) });
});

// PATCH /api/peers/:id - update nickname/color/password
peers.patch('/:id', zValidator('json', PeerUpdateSchema), async (c) => {
  const id = c.req.param('id');
  const { nickname, color, password } = c.req.valid('json');

  let wsToken: string | undefined;
  if (password) {
    const peer = (await listPeers()).find(p => p.id === id);
    if (!peer || peer.id === LOCAL_PEER_ID) {
      return c.json({ error: 'Peer not found or is local' }, 404);
    }
    try {
      wsToken = await loginToPeer(peer.url, password);
    } catch (err) {
      if (err instanceof PeerAuthError) {
        return c.json({ error: err.message, code: 'PEER_AUTH_FAILED' }, 400);
      }
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  }

  const peer = await updatePeer(id, { nickname, color, wsToken });
  if (!peer) return c.json({ error: 'Peer not found' }, 404);
  return c.json({ peer: toClientView(peer) });
});

// DELETE /api/peers/:id
peers.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (id === LOCAL_PEER_ID) {
    return c.json({ error: 'Cannot delete local peer' }, 400);
  }
  const deleted = await deletePeer(id);
  if (!deleted) return c.json({ error: 'Peer not found' }, 404);
  return c.json({ success: true });
});

// PUT /api/peers/order - reorder peers
peers.put('/order', zValidator('json', PeerOrderSchema), async (c) => {
  const { order } = c.req.valid('json');
  await setPeerOrder(order);
  return c.json({ success: true });
});

// POST /api/peers/:id/verify - check connectivity
peers.post('/:id/verify', async (c) => {
  const id = c.req.param('id');
  const peer = await listPeers().then(ps => ps.find(p => p.id === id));
  if (!peer) return c.json({ error: 'Peer not found' }, 404);
  if (peer.id === LOCAL_PEER_ID) {
    return c.json({ status: 'online', latencyMs: 0 });
  }
  const result = await verifyPeer(peer.id, peer.url, peer.wsToken);
  if (result.ok) {
    return c.json({ status: 'online', latencyMs: result.latencyMs });
  }
  return c.json({
    status: result.status === 401 ? 'unauthorized' : 'offline',
    message: result.message,
  });
});

// -----------------------------------------------------------------------------
// History aggregation
// Fetches every peer's `/api/sessions/history/...` in parallel and merges them.
// dirName can collide across peers, so the peer info always rides along and the
// client identifies a project by the composite (peerId, dirName) key.
// -----------------------------------------------------------------------------

interface HistoryProjectsResp {
  projects: Array<{
    dirName: string;
    projectPath: string;
    projectName: string;
    sessionCount: number;
    latestModified?: string;
  }>;
}

async function buildLocalHistoryProjects(): Promise<HistoryProjectsResp['projects']> {
  const [claudeProjects, ...agentProjects] = await Promise.all([
    sessionHistoryService.getProjects(),
    ...Object.values(agentHistoryProviders).map(p => p.getProjects()),
  ]);
  const byDir = new Map<string, HistoryProjectsResp['projects'][number]>();
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
  return Array.from(byDir.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
}

// A peer that errored within this window is skipped on the next fanout so a
// single offline peer doesn't make every history load wait the full peerFetch
// timeout. An explicit verify (recordPeerSuccess) or the cooldown expiring lets
// it back in.
const PEER_ERROR_COOLDOWN_MS = 60_000;
const PEER_LIST_TIMEOUT_MS = 2_500;

function peerRecentlyFailed(peer: { lastErrorAt?: string }): boolean {
  if (!peer.lastErrorAt) return false;
  const ts = new Date(peer.lastErrorAt).getTime();
  return !Number.isNaN(ts) && Date.now() - ts < PEER_ERROR_COOLDOWN_MS;
}

// GET /api/peers/history/projects - merge the projects of every peer
peers.get('/history/projects', async (c) => {
  const allPeers = await listPeers();
  const errors: { peerId: string; message: string }[] = [];

  const results = await Promise.all(allPeers.map(async (peer): Promise<PeerHistoryProject[]> => {
    try {
      let projects: HistoryProjectsResp['projects'];
      if (peer.url === SELF_PEER_URL) {
        projects = await buildLocalHistoryProjects();
      } else if (peerRecentlyFailed(peer)) {
        // Known-down peer: don't block the local list on its timeout.
        errors.push({ peerId: peer.id, message: peer.lastErrorMessage || 'offline (skipped)' });
        return [];
      } else {
        // Short timeout: the project list is interactive and must not hang on a
        // peer that's gone unreachable since the cooldown window.
        const res = await peerFetch(
          peer.id,
          peer.url,
          peer.wsToken,
          '/api/sessions/history/projects',
          undefined,
          PEER_LIST_TIMEOUT_MS,
        );
        if (!res.ok) {
          errors.push({ peerId: peer.id, message: `HTTP ${res.status}` });
          return [];
        }
        const data = (await res.json()) as HistoryProjectsResp;
        if (!Array.isArray(data.projects)) {
          errors.push({ peerId: peer.id, message: 'Invalid response' });
          return [];
        }
        projects = data.projects;
      }
      return projects.map(p => ({
        ...p,
        peerId: peer.id,
        peerNickname: peer.nickname,
        peerColor: peer.color,
      }));
    } catch (err) {
      errors.push({ peerId: peer.id, message: err instanceof Error ? err.message : 'Fetch failed' });
      return [];
    }
  }));

  const merged = results.flat();
  const response: PeerHistoryProjectsResponse = errors.length > 0
    ? { projects: merged, errors }
    : { projects: merged };
  return c.json(response);
});

async function buildLocalProjectSessions(dirName: string): Promise<HistorySession[]> {
  const [claudeSessions, ...agentSessions] = await Promise.all([
    sessionHistoryService.getProjectSessions(dirName),
    ...Object.values(agentHistoryProviders).map(p => p.getProjectSessions(dirName)),
  ]);
  const merged: HistorySession[] = [
    ...claudeSessions.map(s => ({ ...s, agent: s.agent ?? 'claude' as const })),
    ...agentSessions.flat(),
  ].sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return merged;
}

// GET /api/peers/history/:peerId/projects/:dirName - sessions inside one peer's project
peers.get('/history/:peerId/projects/:dirName', async (c) => {
  const peerId = c.req.param('peerId');
  const dirName = c.req.param('dirName');
  const peer = (await listPeers()).find(p => p.id === peerId);
  if (!peer) return c.json({ error: 'Peer not found' }, 404);

  let sessions: HistorySession[];
  if (peer.url === SELF_PEER_URL) {
    sessions = await buildLocalProjectSessions(dirName);
  } else {
    const path = `/api/sessions/history/projects/${encodeURIComponent(dirName)}`;
    const res = await peerFetch(peer.id, peer.url, peer.wsToken, path);
    if (!res.ok) return c.json({ error: `HTTP ${res.status}` }, 502);
    const data = (await res.json()) as { sessions: HistorySession[] };
    sessions = data.sessions ?? [];
  }
  // Attach the peer info
  const enriched = sessions.map(s => ({
    ...s,
    peerId: peer.id,
    peerNickname: peer.nickname,
    peerColor: peer.color,
  }));
  return c.json({ sessions: enriched });
});

// GET /api/peers/history/:peerId/:sessionId/conversation - conversation history from one peer
peers.get('/history/:peerId/:sessionId/conversation', async (c) => {
  const peerId = c.req.param('peerId');
  const sessionId = c.req.param('sessionId');
  const peer = (await listPeers()).find(p => p.id === peerId);
  if (!peer) return c.json({ error: 'Peer not found' }, 404);

  const agent = c.req.query('agent');
  const projectDirName = c.req.query('projectDirName');
  const lastQuery = c.req.query('last');
  const last = lastQuery ? parseInt(lastQuery, 10) : undefined;

  if (peer.url === SELF_PEER_URL) {
    const provider = agent && isAgentProvider(agent) ? agentHistoryProviders[agent] : undefined;
    const messages = provider
      ? await provider.getConversation(sessionId)
      : await sessionHistoryService.getConversation(sessionId, projectDirName);
    return c.json({ messages: last ? messages.slice(-last) : messages });
  }

  const qs = new URLSearchParams();
  if (agent) qs.set('agent', agent);
  if (projectDirName) qs.set('projectDirName', projectDirName);
  if (lastQuery) qs.set('last', lastQuery);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const path = `/api/sessions/history/${encodeURIComponent(sessionId)}/conversation${suffix}`;
  const res = await peerFetch(peer.id, peer.url, peer.wsToken, path);
  if (!res.ok) return c.json({ error: `HTTP ${res.status}` }, 502);
  const data = (await res.json()) as { messages: unknown[] };
  return c.json(data);
});

// POST /api/peers/history/:peerId/resume - resume a session on one peer
peers.post('/history/:peerId/resume', async (c) => {
  const peerId = c.req.param('peerId');
  const peer = (await listPeers()).find(p => p.id === peerId);
  if (!peer) return c.json({ error: 'Peer not found' }, 404);

  const body = await c.req.json().catch(() => ({}));

  if (peer.url === SELF_PEER_URL) {
    // self would have to call the hub's own resume path, but sessions.ts does not
    // export it, and fetching the hub from inside the hub does not hold up either
    // way once auth is in play. So this endpoint stays remote-only: the client
    // calls /api/sessions/history/resume directly for local sessions.
    return c.json({ error: 'Use /api/sessions/history/resume for local sessions' }, 400);
  }

  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const path = '/api/sessions/history/resume';
  const res = await peerFetch(peer.id, peer.url, peer.wsToken, path, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Pass the peer's status through untouched, so codes like duplicate_working_dir reach the client
  if (res.ok) return c.json(data);
  return c.json(data, (res.status >= 400 && res.status < 600 ? res.status : 502) as 400 | 401 | 404 | 409 | 500 | 502);
});

// -----------------------------------------------------------------------------
// Files API proxy (browse / mkdir on a peer)
// The new-session dialog has to show the peer's filesystem, so /api/files/browse
// and /api/files/mkdir are made peer-aware.
// -----------------------------------------------------------------------------

// GET /api/peers/:peerId/files/browse?path=...
peers.get('/:peerId/files/browse', async (c) => {
  const peerId = c.req.param('peerId');
  const peer = (await listPeers()).find(p => p.id === peerId);
  if (!peer) return c.json({ error: 'Peer not found' }, 404);

  const qsPath = c.req.query('path');
  const suffix = qsPath ? `?path=${encodeURIComponent(qsPath)}` : '';
  const path = `/api/files/browse${suffix}`;

  if (peer.url === SELF_PEER_URL) {
    // self can use the hub's own /api/files/browse, and the client calling that
    // directly beats routing through here, so this path is remote-only
    return c.json({ error: 'Use /api/files/browse for local peer' }, 400);
  }

  const res = await peerFetch(peer.id, peer.url, peer.wsToken, path);
  const data = await res.json().catch(() => ({}));
  if (res.ok) return c.json(data as Record<string, unknown>);
  return c.json(data as Record<string, unknown>, (res.status >= 400 && res.status < 600 ? res.status : 502) as 400 | 404 | 500 | 502);
});

// POST /api/peers/:peerId/files/mkdir
peers.post('/:peerId/files/mkdir', async (c) => {
  const peerId = c.req.param('peerId');
  const peer = (await listPeers()).find(p => p.id === peerId);
  if (!peer) return c.json({ error: 'Peer not found' }, 404);
  if (peer.url === SELF_PEER_URL) {
    return c.json({ error: 'Use /api/files/mkdir for local peer' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const res = await peerFetch(peer.id, peer.url, peer.wsToken, '/api/files/mkdir', init);
  const data = await res.json().catch(() => ({}));
  if (res.ok) return c.json(data as Record<string, unknown>);
  return c.json(data as Record<string, unknown>, (res.status >= 400 && res.status < 600 ? res.status : 502) as 400 | 404 | 500 | 502);
});

// POST /api/peers/:peerId/upload/image
// Forwards an image upload to the peer and returns the peer's local absolute path.
// Required so the Claude Code running on that peer can read the file directly.
peers.post('/:peerId/upload/image', async (c) => {
  const peerId = c.req.param('peerId');
  const peer = (await listPeers()).find(p => p.id === peerId);
  if (!peer) return c.json({ error: 'Peer not found' }, 404);

  // -- local: store on the hub itself
  if (peer.url === SELF_PEER_URL) {
    try {
      const formData = await c.req.formData();
      const file = formData.get('image');
      if (!file || !(file instanceof File)) {
        return c.json({ error: 'No image file provided' }, 400);
      }
      const result = await saveUploadedImage(file);
      return c.json({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload image';
      const status = /Invalid file type|too large/.test(message) ? 400 : 500;
      if (status === 500) console.error('Upload error (self):', err);
      return c.json({ error: message }, status);
    }
  }

  // -- remote: relay the multipart body to the peer's /api/upload/image
  let incoming: FormData;
  try {
    incoming = await c.req.formData();
  } catch {
    return c.json({ error: 'Invalid multipart body' }, 400);
  }
  const file = incoming.get('image');
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No image file provided' }, 400);
  }

  // Repack into a fresh FormData before forwarding: passing the original one
  // straight to fetch as the body makes boundary handling unreliable
  const outgoing = new FormData();
  outgoing.append('image', file, file.name);

  try {
    const res = await peerFetch(peer.id, peer.url, peer.wsToken, '/api/upload/image', {
      method: 'POST',
      body: outgoing,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const status = (res.status >= 400 && res.status < 600 ? res.status : 502) as 400 | 401 | 404 | 500 | 502;
      return c.json(data, status);
    }
    return c.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload to peer failed';
    return c.json({ error: message }, 502);
  }
});

// GET /api/peers/:peerId/dashboard - return the dashboard of a peer (or self)
peers.get('/:peerId/dashboard', async (c) => {
  const peerId = c.req.param('peerId');
  const peer = (await listPeers()).find(p => p.id === peerId);
  if (!peer) return c.json({ error: 'Peer not found' }, 404);

  if (peer.url === SELF_PEER_URL) {
    // Through the cache, not `buildDashboard` directly: the local server card
    // polls this on its own timer, and an uncached call here would rebuild
    // everything (including the Anthropic fetch) behind the panel's back.
    return c.json(await getDashboard());
  }

  try {
    const res = await peerFetch(peer.id, peer.url, peer.wsToken, '/api/dashboard');
    if (!res.ok) {
      return c.json({ error: `HTTP ${res.status}` }, 502);
    }
    const data = (await res.json()) as DashboardResponse;
    return c.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Fetch failed';
    return c.json({ error: message }, 502);
  }
});

// GET /api/peers/sessions - merge and return the session list of every peer
peers.get('/sessions', async (c) => {
  const allPeers = await listPeers();
  const errors: { peerId: string; message: string }[] = [];

  const results = await Promise.all(allPeers.map(async (peer): Promise<PeerSession[]> => {
    const enrich = (s: ExtendedSessionResponse): PeerSession => ({
      ...s,
      peerId: peer.id,
      peerNickname: peer.nickname,
      peerColor: peer.color,
    });

    if (peer.url === SELF_PEER_URL) {
      try {
        const local = await buildSessionsList();
        return local.map(enrich);
      } catch (err) {
        errors.push({ peerId: peer.id, message: err instanceof Error ? err.message : 'Local sessions failed' });
        return [];
      }
    }

    try {
      const res = await peerFetch(peer.id, peer.url, peer.wsToken, '/api/sessions');
      if (!res.ok) {
        errors.push({ peerId: peer.id, message: `HTTP ${res.status}` });
        return [];
      }
      const data = (await res.json()) as { sessions?: ExtendedSessionResponse[] };
      if (!data || !Array.isArray(data.sessions)) {
        errors.push({ peerId: peer.id, message: 'Invalid response' });
        return [];
      }
      return data.sessions.map(enrich);
    } catch (err) {
      errors.push({ peerId: peer.id, message: err instanceof Error ? err.message : 'Fetch failed' });
      return [];
    }
  }));

  const merged = results.flat();
  const response: PeerSessionsResponse = errors.length > 0
    ? { sessions: merged, errors }
    : { sessions: merged };
  return c.json(response);
});

// -----------------------------------------------------------------------------
// Generic Files API proxy
// -----------------------------------------------------------------------------
// FileViewer (list / read / raw / changes / git-changes / git-diff / language /
// download / upload) needs to target the peer that owns the files on disk.
// The individual /browse and /mkdir proxies above stay as-is — they were added
// first and have specific shapes. Everything else is forwarded via this
// catch-all so we don't have to hand-write a route per endpoint.
//
// We bypass peerFetch (5s timeout) so that streamed responses such as
// /files/raw on a large image or video don't get cut off mid-flight.

function normalizePeerBaseUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

async function proxyPeerFiles(c: Context): Promise<Response> {
  const peerId = c.req.param('peerId');
  const peer = (await listPeers()).find(p => p.id === peerId);
  if (!peer) return c.json({ error: 'Peer not found' }, 404);
  if (peer.url === SELF_PEER_URL) {
    return c.json({ error: 'Use /api/files/* for local peer' }, 400);
  }
  if (!isSafePeerUrl(peer.url)) {
    return c.json({ error: 'Unsafe peer URL' }, 400);
  }

  // /api/peers/:peerId/files/<rest>?<query>  →  peer's /api/files/<rest>?<query>
  const incoming = new URL(c.req.url);
  const prefix = `/api/peers/${peerId}/files`;
  const subpath = incoming.pathname.startsWith(prefix)
    ? incoming.pathname.slice(prefix.length)
    : '';
  const targetPath = `/api/files${subpath}${incoming.search}`;

  const headers = new Headers();
  if (peer.wsToken) headers.set('Authorization', `Bearer ${peer.wsToken}`);
  const ct = c.req.header('Content-Type');
  if (ct) headers.set('Content-Type', ct);
  // Forward range/conditional headers so peer-hosted media (video/audio) can be
  // seeked and large files stream as ranged 206s instead of full-body 200s —
  // the peer's /files/raw supports Range only when the header reaches it.
  for (const h of ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }

  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = c.req.raw.body;
    // Bun requires duplex: 'half' when streaming a request body.
    (init as RequestInit & { duplex?: string }).duplex = 'half';
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${normalizePeerBaseUrl(peer.url)}${targetPath}`, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Peer unreachable';
    return c.json({ error: message }, 502);
  }

  // Strip hop-by-hop headers but keep Content-Type / Content-Length etc.
  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (lk === 'connection' || lk === 'transfer-encoding' || lk === 'keep-alive') continue;
    respHeaders.set(k, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

peers.all('/:peerId/files/list', proxyPeerFiles);
peers.all('/:peerId/files/read', proxyPeerFiles);
peers.all('/:peerId/files/raw', proxyPeerFiles);
peers.all('/:peerId/files/download', proxyPeerFiles);
peers.all('/:peerId/files/upload', proxyPeerFiles);
peers.all('/:peerId/files/language', proxyPeerFiles);
peers.all('/:peerId/files/changes/:dir', proxyPeerFiles);
peers.all('/:peerId/files/git-changes/:dir', proxyPeerFiles);
peers.all('/:peerId/files/git-diff/:dir', proxyPeerFiles);
peers.all('/:peerId/files/images/:filename', proxyPeerFiles);
