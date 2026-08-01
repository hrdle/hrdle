/**
 * peer-discovery: scans the Tailscale tailnet for peers running hrdle.
 *
 * - Lists the online peers via `tailscale status --json`
 * - Fetches every peer's health endpoint in parallel (3s timeout)
 * - A 200 means hrdle is there, and its version is read from the response
 * - Skips this machine itself (matched by DNSName)
 */

import { listPeers } from './peer-registry';
import { IDENTITY } from '../../../shared/identity';
import { SELF_PEER_URL, type DiscoveredPeer } from '../../../shared/types';

const DISCOVERY_TIMEOUT_MS = 3_000;
/**
 * The port a peer is expected to answer on.
 *
 * Composed from identity rather than written here: this was a literal 5923 from
 * before the rename, so after it every probe went to a port nothing listens on
 * and a tailnet full of installs discovered nothing (#459). A port number is
 * exactly the kind of constant that looks too obvious to be wrong.
 */
const DEFAULT_PORT = IDENTITY.defaultPort;

interface TailscaleStatus {
  Self?: { DNSName?: string };
  Peer?: Record<string, {
    HostName?: string;
    DNSName?: string;
    Online?: boolean;
    OS?: string;
  }>;
}

function normalizeDns(dns: string | undefined): string {
  if (!dns) return '';
  // Strip the trailing "."
  return dns.replace(/\.$/, '');
}

async function fetchTailscaleStatus(): Promise<TailscaleStatus | null> {
  try {
    const proc = Bun.spawnSync(['tailscale', 'status', '--json']);
    if (proc.exitCode !== 0) return null;
    return JSON.parse(proc.stdout.toString()) as TailscaleStatus;
  } catch {
    return null;
  }
}

async function probeCchub(url: string): Promise<{ ok: true; version?: string } | { ok: false }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    const res = await fetch(`${url}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json().catch(() => ({}))) as { status?: string; version?: string };
    if (body.status !== 'ok') return { ok: false };
    return { ok: true, version: body.version };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverPeers(): Promise<DiscoveredPeer[]> {
  const status = await fetchTailscaleStatus();
  if (!status) return [];

  const selfDns = normalizeDns(status.Self?.DNSName);
  const existingPeers = await listPeers();

  // Index the registered peers' URLs by hostname:port
  const existingByHost = new Map<string, { nickname: string }>();
  for (const p of existingPeers) {
    if (p.url === SELF_PEER_URL) continue;
    try {
      const u = new URL(p.url);
      existingByHost.set(`${u.hostname}:${u.port || '443'}`, { nickname: p.nickname });
    } catch {
      /* skip malformed */
    }
  }

  const candidates: { displayName: string; hostname: string }[] = [];
  for (const peer of Object.values(status.Peer ?? {})) {
    if (!peer.Online) continue;
    const dns = normalizeDns(peer.DNSName);
    if (!dns || dns === selfDns) continue;
    candidates.push({
      displayName: peer.HostName ?? dns,
      hostname: dns,
    });
  }

  // Probe in parallel
  const results = await Promise.all(candidates.map(async (c) => {
    const url = `https://${c.hostname}:${DEFAULT_PORT}`;
    const probe = await probeCchub(url);
    if (!probe.ok) return null;
    const existing = existingByHost.get(`${c.hostname}:${DEFAULT_PORT}`);
    const discovered: DiscoveredPeer = {
      displayName: c.displayName,
      hostname: c.hostname,
      url,
      version: probe.version,
      alreadyRegistered: !!existing,
      registeredAs: existing?.nickname,
    };
    return discovered;
  }));

  return results.filter((r): r is DiscoveredPeer => r !== null);
}
