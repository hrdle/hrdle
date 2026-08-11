import { isIP } from 'node:net';

/**
 * Guards peer URLs against SSRF. Peers are other Hrdle servers reached
 * over Tailscale, so legitimate hosts are *.ts.net or the Tailscale ranges
 * (CGNAT 100.64.0.0/10, ULA fd7a:115c:a1e0::/48) — those stay allowed. We
 * reject non-https schemes (kills file:/gopher:/javascript:/http:) and
 * loopback / link-local (incl. 169.254.169.254 cloud metadata) / RFC1918
 * private hosts, which are the SSRF targets.
 *
 * Note: hostnames are allowed (we can't resolve DNS here); this closes the
 * IP-literal and non-https vectors. Full resolve-time validation would be a
 * deeper follow-up.
 */
export function isSafePeerUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  const kind = isIP(host);
  if (kind === 4) return !isBlockedIpv4(host);
  if (kind === 6) return !isBlockedIpv6(host);
  // A resolvable hostname (e.g. peer.tailnet.ts.net) — allowed.
  return true;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inRange(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (b & mask);
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  if (inRange(n, '100.64.0.0', 10)) return false; // Tailscale CGNAT — allowed
  return (
    inRange(n, '127.0.0.0', 8) || // loopback
    inRange(n, '10.0.0.0', 8) || // RFC1918
    inRange(n, '172.16.0.0', 12) || // RFC1918
    inRange(n, '192.168.0.0', 16) || // RFC1918
    inRange(n, '169.254.0.0', 16) || // link-local + cloud metadata
    inRange(n, '0.0.0.0', 8) // "this" network
  );
}

function isBlockedIpv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  // link-local fe80::/10 (fe80..febf)
  if (/^fe[89ab]/.test(h)) return true;
  // Tailscale ULA fd7a:115c:a1e0::/48 — allowed before the general ULA block.
  if (h.startsWith('fd7a:115c:a1e0')) return false;
  // other ULA fc00::/7 (fc.. / fd..)
  if (/^f[cd]/.test(h)) return true;
  // IPv4-mapped (::ffff:127.0.0.1 etc.)
  const mapped = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}
