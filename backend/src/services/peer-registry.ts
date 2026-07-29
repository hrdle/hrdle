import { join } from 'node:path';
import { readFile, writeFile, chmod, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ensureDataDir } from '../utils/storage';
import {
  type Peer,
  LOCAL_PEER_ID,
  SELF_PEER_URL,
} from '../../../shared/types';

const PEERS_FILE = 'peers.json';

// Module-level mutex serialising every load→mutate→save sequence against
// peers.json. routes/peers.ts fans out per-peer fetches with Promise.all and
// each completion calls recordPeerSuccess / recordPeerFailure; without this
// chain, interleaved load/save calls clobbered each other's lastSeenAt and
// could even reset a freshly-issued wsToken to a stale value. #251
let mutationQueue: Promise<unknown> = Promise.resolve();
function withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(fn, fn);
  // Don't propagate failures into the queue's success chain — the next caller
  // must still get to run even if this one rejected.
  mutationQueue = next.catch(() => undefined);
  return next;
}

// Palette assigned round-robin as peers are added.
// Unless the user picks a color, each new peer takes the next PALETTE entry.
const COLOR_PALETTE = [
  '#10b981', // emerald
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#84cc16', // lime
];

// Peer tokens are stored on disk in plain text (this assumes a home machine).
// Swap in an OS keychain later if that ever stops being true.
interface StoredPeer extends Peer {
  // Token obtained by logging in to the peer; self has none
  wsToken?: string;
  // Time and result of the last verify
  lastSeenAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
}

interface PeersStore {
  peers: StoredPeer[];
}

async function getFilePath(): Promise<string> {
  const dataDir = await ensureDataDir();
  return join(dataDir, PEERS_FILE);
}

async function load(): Promise<PeersStore> {
  const filePath = await getFilePath();
  try {
    const data = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data) as PeersStore;
    if (!Array.isArray(parsed.peers)) {
      return { peers: [] };
    }
    // Rebuild rather than pass `parsed` through, so keys we no longer own —
    // notably the pre-herdr `sessionOrder` — get dropped on the next save
    // instead of round-tripping forever.
    return { peers: parsed.peers };
  } catch {
    return { peers: [] };
  }
}

async function save(store: PeersStore): Promise<void> {
  const filePath = await getFilePath();
  // Write to a sibling temp file and rename atomically so a crash mid-write
  // can't truncate peers.json (which would lose every peer's wsToken). #251
  const tempPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    // Holds wsToken, so restrict it to owner read/write. writeFile's mode only
    // applies when the file is created - overwriting an existing file can leave
    // 0644 behind from an earlier umask, so chmod runs every time.
    await writeFile(tempPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    try {
      await chmod(tempPath, 0o600);
    } catch {
      /* permissions might already be correct, or fs doesn't support chmod */
    }
    await rename(tempPath, filePath);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      /* best-effort cleanup if rename never happened */
    }
    throw err;
  }
}

function generateId(): string {
  return `p_${randomBytes(4).toString('hex')}`;
}

function pickColor(existing: StoredPeer[]): string {
  const used = new Set(existing.map(p => p.color.toLowerCase()));
  for (const c of COLOR_PALETTE) {
    if (!used.has(c.toLowerCase())) return c;
  }
  // Once the palette is exhausted, pick at random
  return COLOR_PALETTE[existing.length % COLOR_PALETTE.length] ?? '#64748b';
}

function localPeer(): StoredPeer {
  return {
    id: LOCAL_PEER_ID,
    nickname: 'Local',
    url: SELF_PEER_URL,
    color: COLOR_PALETTE[0] ?? '#10b981',
    order: 0,
  };
}

/**
 * Returns every peer, always with self first.
 * Sorted by ascending order.
 */
export async function listPeers(): Promise<StoredPeer[]> {
  const store = await load();
  const hasLocal = store.peers.some(p => p.id === LOCAL_PEER_ID);
  const peers = hasLocal ? [...store.peers] : [localPeer(), ...store.peers];
  return peers.sort((a, b) => a.order - b.order);
}

export async function getPeer(id: string): Promise<StoredPeer | null> {
  const peers = await listPeers();
  return peers.find(p => p.id === id) ?? null;
}

export interface CreatePeerArgs {
  nickname: string;
  url: string;
  color?: string;
  wsToken?: string;
}

export async function createPeer(args: CreatePeerArgs): Promise<StoredPeer> {
  return withMutationLock(async () => {
    const store = await load();
    const id = generateId();
    const existing = await listPeers();
    const order = existing.reduce((max, p) => Math.max(max, p.order), 0) + 1;

    const peer: StoredPeer = {
      id,
      nickname: args.nickname,
      url: args.url,
      color: args.color ?? pickColor(existing),
      order,
      wsToken: args.wsToken,
      lastSeenAt: new Date().toISOString(),
    };

    store.peers.push(peer);
    await save(store);
    return peer;
  });
}

export interface UpdatePeerArgs {
  nickname?: string;
  color?: string;
  wsToken?: string;
}

export async function updatePeer(id: string, args: UpdatePeerArgs): Promise<StoredPeer | null> {
  return withMutationLock(async () => {
    if (id === LOCAL_PEER_ID) {
      // The local peer only allows nickname/color edits; it holds no token
      const store = await load();
      let local = store.peers.find(p => p.id === LOCAL_PEER_ID);
      if (!local) {
        local = localPeer();
        store.peers.push(local);
      }
      if (args.nickname !== undefined) local.nickname = args.nickname;
      if (args.color !== undefined) local.color = args.color;
      await save(store);
      return local;
    }

    const store = await load();
    const peer = store.peers.find(p => p.id === id);
    if (!peer) return null;

    if (args.nickname !== undefined) peer.nickname = args.nickname;
    if (args.color !== undefined) peer.color = args.color;
    if (args.wsToken !== undefined) {
      peer.wsToken = args.wsToken;
      peer.lastSeenAt = new Date().toISOString();
      peer.lastErrorAt = undefined;
      peer.lastErrorMessage = undefined;
    }

    await save(store);
    return peer;
  });
}

export async function deletePeer(id: string): Promise<boolean> {
  return withMutationLock(async () => {
    if (id === LOCAL_PEER_ID) return false; // self cannot be removed
    const store = await load();
    const before = store.peers.length;
    store.peers = store.peers.filter(p => p.id !== id);
    if (store.peers.length === before) return false;
    await save(store);
    return true;
  });
}

export async function setPeerOrder(orderedIds: string[]): Promise<void> {
  return withMutationLock(async () => {
    const store = await load();
    const indexById = new Map(orderedIds.map((id, i) => [id, i]));
    // Peers missing from the array fall to the end
    const maxIndex = orderedIds.length;
    for (const peer of store.peers) {
      const idx = indexById.get(peer.id);
      peer.order = idx !== undefined ? idx : maxIndex + peer.order;
    }
    await save(store);
  });
}

export async function recordPeerSuccess(id: string): Promise<void> {
  if (id === LOCAL_PEER_ID) return;
  return withMutationLock(async () => {
    const store = await load();
    const peer = store.peers.find(p => p.id === id);
    if (!peer) return;
    peer.lastSeenAt = new Date().toISOString();
    peer.lastErrorAt = undefined;
    peer.lastErrorMessage = undefined;
    await save(store);
  });
}

export async function recordPeerFailure(id: string, message: string): Promise<void> {
  if (id === LOCAL_PEER_ID) return;
  return withMutationLock(async () => {
    const store = await load();
    const peer = store.peers.find(p => p.id === id);
    if (!peer) return;
    peer.lastErrorAt = new Date().toISOString();
    peer.lastErrorMessage = message;
    await save(store);
  });
}

export type { StoredPeer };
