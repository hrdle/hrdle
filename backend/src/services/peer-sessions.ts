/**
 * The peers' sessions, as the glasses see them.
 *
 * The EVEN G2 app talks to one server and has no notion of a peer: it lists
 * `GET /api/sessions`, reads `…/history/<id>/conversation`, and answers with
 * `POST /api/sessions/<id>/prompt`. Everything it can reach is therefore
 * whatever that one list contains. Registering the other machines as peers
 * does not help it — that list lives in the browser, which fans out to
 * `/api/peers/sessions` itself.
 *
 * So the merge happens here, on the server the glasses are connected to, and
 * the id carries the peer: `peer:<peerId>:<its own id>`. Every route the
 * glasses use parses that back and forwards the request to the machine that
 * owns the session, which keeps the app unchanged (it encodes the id and hands
 * it back, whatever shape it has).
 *
 * The browser is deliberately left out of this: it already shows every peer's
 * sessions by asking each peer directly, and a merged list here would show
 * them a second time. `sessionsWithPeers()` is called only for the glasses —
 * the `?local=1` list and the browsers' `sessions-updated` frame stay exactly
 * what upstream sends.
 */
import type { ExtendedSessionResponse, GlassesRelayItem } from '../../../shared/types';
import { LOCAL_PEER_ID, SELF_PEER_URL } from '../../../shared/types';
import { listPeers, type StoredPeer } from './peer-registry';
import { peerFetch } from './peer-auth';

const PEER_SESSION_PREFIX = 'peer:';

/** How long a fetched peer list is reused. The sessions push runs every 5s and
 *  herdr events push on top of that, so without this every agent keystroke on
 *  this machine would cost a round trip to every other one. */
const PEER_SESSIONS_TTL_MS = 4_000;

/** Same short leash the peer history fanout uses: a list is interactive, and a
 *  peer that went unreachable must not hold it. */
const PEER_LIST_TIMEOUT_MS = 2_500;

/** Mirrors the cooldown in routes/peers.ts (kept here rather than shared, to
 *  keep the diff against upstream inside this file). */
const PEER_ERROR_COOLDOWN_MS = 60_000;

export interface PeerSessionRef {
  peerId: string;
  /** The id the owning peer knows this session by. */
  localId: string;
}

/** `peer:<peerId>:<localId>`. Peer ids are `p_<hex>`, so the second colon is
 *  always the separator and the local id may contain colons of its own. */
export function makePeerSessionId(peerId: string, localId: string): string {
  return `${PEER_SESSION_PREFIX}${peerId}:${localId}`;
}

/** The peer and local id behind a namespaced id, or null when the id is this
 *  server's own — which is what every id was before this change. */
export function parsePeerSessionId(id: string): PeerSessionRef | null {
  if (!id.startsWith(PEER_SESSION_PREFIX)) return null;
  const rest = id.slice(PEER_SESSION_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const localId = rest.slice(sep + 1);
  if (!localId) return null;
  // The local id is put back into a path on the peer, and encodeURIComponent
  // leaves a bare `..` alone — which `fetch` then resolves away, aiming the
  // request at some other endpoint of that machine. No session is called this.
  if (localId === '.' || localId === '..') return null;
  return { peerId: rest.slice(0, sep), localId };
}

export function isPeerSessionId(id: string): boolean {
  return parsePeerSessionId(id) !== null;
}

type PeerLabel = Pick<StoredPeer, 'id' | 'nickname' | 'color'>;

/**
 * One peer's session, addressable from here.
 *
 * Every id the glasses hand back to a server is rewritten: the session id
 * (prompt / pane input / stt), and the three conversation ids it reads from
 * (`ccSessionId`, `agentSessionId`, and the same field on each pane, which is
 * what a pane of a multi-pane workspace is read by).
 *
 * `paneId` is left alone. It is only ever sent inside a request that already
 * names its session, so it is unambiguous by construction — and the peer
 * expects its own value back. `bridgeSessionId` likewise: it addresses a
 * conversation on claude.ai rather than on any hrdle, so it is already valid
 * from here and prefixing it would only break the link built from it.
 *
 * The nickname goes into the displayed title because the app has no peer field
 * to render: `customTitle` when the peer set one (the glasses prefer it over
 * the name), otherwise the name.
 */
export function namespacePeerSession(
  session: ExtendedSessionResponse,
  peer: PeerLabel,
): ExtendedSessionResponse {
  const tag = (value: string | undefined) =>
    value === undefined ? undefined : makePeerSessionId(peer.id, value);
  const titled = (text: string) => `${peer.nickname}/${text}`;

  return {
    ...session,
    id: makePeerSessionId(peer.id, session.id),
    ccSessionId: tag(session.ccSessionId),
    agentSessionId: tag(session.agentSessionId),
    panes: session.panes?.map(pane => ({ ...pane, agentSessionId: tag(pane.agentSessionId) })),
    ...(session.customTitle
      ? { customTitle: titled(session.customTitle) }
      : { name: titled(session.name) }),
    peerId: peer.id,
    peerNickname: peer.nickname,
    peerColor: peer.color,
  };
}

/**
 * One machine's sessions. The order of machines is the peers settings'
 * (`PUT /api/peers/order`), so the groups are kept whole and sorted last; an
 * order decided here would be a second source of truth.
 */
interface PeerSessionGroup {
  order?: number;
  sessions: ExtendedSessionResponse[];
}

interface CachedPeerSessions {
  at: number;
  groups: PeerSessionGroup[];
  /** Where this server sits: the peers settings list it alongside the others. */
  localOrder?: number;
  /** This server's nickname, which is how the glasses' machine screen names it. */
  localNickname?: string;
}

let cache: CachedPeerSessions | null = null;
let inFlight: Promise<CachedPeerSessions> | null = null;

/** A peer stored before order existed goes last. */
const ORDER_LAST = Number.MAX_SAFE_INTEGER;

function orderValue(item: { order?: number }): number {
  return typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : ORDER_LAST;
}

/** By the peers settings' order; equal orders keep their given sequence (sort is stable). */
export function sortByPeerOrder<T extends { order?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => orderValue(a) - orderValue(b));
}

/** Drop the cache. Tests only — the TTL is what production runs on. */
export function resetPeerSessionsCache(): void {
  cache = null;
  inFlight = null;
}

function peerRecentlyFailed(peer: StoredPeer): boolean {
  if (!peer.lastErrorAt) return false;
  const ts = new Date(peer.lastErrorAt).getTime();
  return !Number.isNaN(ts) && Date.now() - ts < PEER_ERROR_COOLDOWN_MS;
}

async function fetchOnePeer(peer: StoredPeer): Promise<ExtendedSessionResponse[]> {
  if (peerRecentlyFailed(peer)) return [];
  try {
    // `?local=1` asks for that machine's own sessions. Without it a peer
    // running this same code would answer with its peers' sessions too —
    // including this one's, back again.
    const res = await peerFetch(
      peer.id,
      peer.url,
      peer.wsToken,
      '/api/sessions?local=1',
      undefined,
      PEER_LIST_TIMEOUT_MS,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { sessions?: ExtendedSessionResponse[] };
    if (!Array.isArray(data?.sessions)) return [];
    // A peer that ignored `?local=1` (an older build) is not allowed to lend us
    // sessions it does not own: they would be addressed by its peer ids, which
    // mean nothing here.
    return data.sessions
      .filter(s => !isPeerSessionId(s.id))
      .map(s => namespacePeerSession(s, peer));
  } catch {
    // peerFetch already recorded the failure, and one unreachable machine must
    // not empty the list of the ones that answered.
    return [];
  }
}

async function fetchPeerSessions(): Promise<CachedPeerSessions> {
  const all = await listPeers();
  const remote = all.filter(p => p.url !== SELF_PEER_URL);
  const groups = remote.length === 0
    ? []
    : await Promise.all(remote.map(async (peer): Promise<PeerSessionGroup> => ({
      order: peer.order,
      sessions: await fetchOnePeer(peer),
    })));
  const entry: CachedPeerSessions = {
    at: Date.now(),
    groups,
    localOrder: all.find(p => p.id === LOCAL_PEER_ID)?.order,
    localNickname: all.find(p => p.id === LOCAL_PEER_ID)?.nickname,
  };
  cache = entry;
  return entry;
}

/** The groups, ordered. Cached for a few seconds, and never two fanouts at once. */
async function peerSessionGroups(): Promise<CachedPeerSessions> {
  if (cache && Date.now() - cache.at < PEER_SESSIONS_TTL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = fetchPeerSessions().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Every peer's waiting questions and notices, namespaced.
 *
 * The glasses talk to one machine, and the thing that turns a blocked pane into
 * a card only ever looked at that machine's own panes - so a question asked on
 * another one reached the list (which this file already merges) and the
 * conversation, and then nothing appeared to answer. Each peer has already
 * built its own items, so this asks for them rather than scraping panes across
 * the network.
 *
 * `sessionId` is namespaced because that is what an answer is addressed to, and
 * the pane routing here already forwards it. `id` is namespaced because two
 * machines number their items independently and the glasses hold one queue.
 */
export async function listPeerRelayItems(): Promise<GlassesRelayItem[]> {
  const peers = (await listPeers()).filter(p => p.url !== SELF_PEER_URL);
  if (peers.length === 0) return [];
  const groups = await Promise.all(peers.map(async peer => {
    if (peerRecentlyFailed(peer)) return [];
    try {
      const res = await peerFetch(peer.id, peer.url, peer.wsToken, '/api/glasses/relay', undefined, PEER_LIST_TIMEOUT_MS);
      if (!res.ok) return [];
      const data = (await res.json()) as { items?: GlassesRelayItem[] };
      if (!Array.isArray(data?.items)) return [];
      return data.items
        // A peer running this same code would otherwise lend us its peers'
        // items, addressed by ids that mean nothing here.
        .filter(i => !isPeerSessionId(i.sessionId))
        .map(i => ({
          ...i,
          id: makePeerSessionId(peer.id, i.id),
          sessionId: makePeerSessionId(peer.id, i.sessionId),
        }));
    } catch {
      return [];
    }
  }));
  return groups.flat();
}

/** Every registered peer's sessions, namespaced. Cached for a few seconds and
 *  never fanned out twice at once. */
export async function listPeerSessions(): Promise<ExtendedSessionResponse[]> {
  return (await peerSessionGroups()).groups.flatMap(g => g.sessions);
}

/**
 * The list the glasses get: this machine's sessions and each peer's, **in the
 * order the peers settings say** (`PUT /api/peers/order`, where this server is
 * one entry among the others). "That machine first" is decided there, and a
 * merge that put this server first regardless would silently ignore it.
 *
 * Returns the given array unchanged when there is nothing to add, so a caller
 * comparing by identity can tell that this is still the plain local list.
 */
export async function sessionsWithPeers(
  local: ExtendedSessionResponse[],
): Promise<ExtendedSessionResponse[]> {
  const { groups, localOrder, localNickname } = await peerSessionGroups();
  if (groups.length === 0) return local;
  // This server's own sessions are tagged with its machine too: the glasses'
  // machine screen only groups the list by the tag and never asks which
  // machine is this one. Untagged with no peers, when there is no such screen.
  const tagged = local.map(s => ({ ...s, peerId: LOCAL_PEER_ID, peerNickname: localNickname }));
  return sortByPeerOrder([...groups, { order: localOrder, sessions: tagged }])
    .flatMap(g => g.sessions);
}

/**
 * Forward a request about a peer-owned session to the machine that owns it.
 *
 * `path` is the peer's own path with its own id already in it — the caller
 * knows which endpoint it is proxying, this only knows where to send it.
 */
export async function forwardToPeer(
  ref: PeerSessionRef,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const peer = (await listPeers()).find(p => p.id === ref.peerId);
  if (!peer || peer.url === SELF_PEER_URL) {
    return Response.json({ error: 'Peer not found' }, { status: 404 });
  }
  try {
    const res = await peerFetch(peer.id, peer.url, peer.wsToken, path, init);
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Peer unreachable';
    return Response.json({ error: message }, { status: 502 });
  }
}

/** `/api/sessions/<localId>…` on the owning peer. */
export function peerSessionPath(ref: PeerSessionRef, suffix: string): string {
  return `/api/sessions/${encodeURIComponent(ref.localId)}${suffix}`;
}
