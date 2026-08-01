// The one plaintext door: where this machine is, for a phone that only knows
// its address.
//
// Setting the glasses app up means telling it a Tailscale FQDN -
// `https://beelink-arch.tail4459c9.ts.net:5924` - typed on a phone keyboard off
// a terminal window across the room. Every way of avoiding that typing has to
// start by reaching this server somehow, and reaching it over HTTPS is exactly
// what a phone cannot do before it knows the name: the certificate is issued for
// the FQDN, so an IP or a short hostname fails TLS, and `fetch` has no way to
// proceed past a certificate error the way a browser's warning page does.
//
// So there is one endpoint, on one extra port, in plaintext, and all it does is
// answer with the name. Type `91.210.90` or `beelink-arch`, get back
// `https://beelink-arch.tail4459c9.ts.net:5924`, and every request after that is
// ordinary verified HTTPS.
//
// What travels in the clear is the FQDN, the product name and the version.
// Nothing else is served here - no API, no session data, no authentication. And
// "in the clear" is relative: the reply only goes to callers on a private or
// CGNAT address, and a tailnet caller's packets are inside WireGuard already.

import { IDENTITY } from '../../../shared/identity';

/** What a caller gets back. Deliberately small - it is a signpost, not an API. */
export interface DiscoveryInfo {
  product: string;
  version: string;
  /** The address every later request should use. */
  url: string;
}

/**
 * Addresses this door answers to.
 *
 * Loopback, RFC1918 and the CGNAT range Tailscale allocates from, plus the IPv6
 * equivalents (Tailscale's own ULA prefix is `fd7a:115c:a1e0::/48`, inside `fd`).
 * A caller from the public internet gets nothing - not because the FQDN is a
 * secret, but because a reply is an admission that something is listening.
 */
export function isLocalAddress(ip: string): boolean {
  const address = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (address === '::1' || address === '127.0.0.1') return true;
  if (/^127\./.test(address)) return true;
  if (/^10\./.test(address)) return true;
  if (/^192\.168\./.test(address)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true;
  // 100.64.0.0/10 - the CGNAT block Tailscale hands out from.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return true;
  // Unique-local and link-local IPv6.
  if (/^f[cd]/i.test(address)) return true;
  if (/^fe80:/i.test(address)) return true;
  return false;
}

/**
 * The part of a Tailscale address worth typing.
 *
 * Every Tailscale address starts `100.`, and the rest is allocated per node
 * rather than per tailnet - the machines on one tailnet differ from the second
 * octet onwards, so nothing below this can be dropped. Nine characters instead
 * of forty-three is the whole of the improvement, and it is enough.
 */
export function shortTailscaleIp(ip: string): string | null {
  return /^100\.\d+\.\d+\.\d+$/.test(ip) ? ip.slice(4) : null;
}

/**
 * Put back what a short form left out.
 *
 * Accepts what a person would actually type: `91.210.90`, the whole address, or
 * anything else unchanged (a hostname resolves through MagicDNS on its own).
 */
export function expandTailscaleIp(input: string): string {
  const trimmed = input.trim();
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? `100.${trimmed}` : trimmed;
}

export interface DiscoveryServer {
  port: number;
  stop(): void;
}

/**
 * Start the discovery listener, or return null if the port will not bind.
 *
 * A refusal is not fatal: everything the product does still works, and the only
 * thing lost is being able to find it by short address. Ports get taken, and
 * exiting over a convenience would be the wrong trade.
 */
export function startDiscoveryServer(port: number, info: DiscoveryInfo): DiscoveryServer | null {
  try {
    const server = Bun.serve({
      port,
      hostname: '0.0.0.0',
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname !== '/whoami') {
          return new Response('not found', { status: 404 });
        }
        const peer = srv.requestIP(req)?.address;
        if (!peer || !isLocalAddress(peer)) {
          return new Response('forbidden', { status: 403 });
        }
        return Response.json(info, {
          headers: {
            // The caller is a page on another origin - the glasses app's own
            // container - and it has no way to relax this from its side.
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          },
        });
      },
    });
    return {
      // What was actually bound, not what was asked for: a test passes 0 and
      // needs to know where to knock.
      port: server.port ?? port,
      stop: () => server.stop(true),
    };
  } catch (err) {
    console.warn(
      `warning: the discovery listener could not start on port ${port}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    console.warn(`  ${IDENTITY.productName} still works; short addresses will not resolve.`);
    return null;
  }
}
