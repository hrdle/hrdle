/**
 * Whether the address this page was served from is a tailnet one.
 *
 * Hrdle is reached over Tailscale - the certificate is issued for the `.ts.net`
 * name, and the machine is otherwise not routable from a phone. So when the
 * server stops answering a browser that loaded it from an address of this
 * shape, the VPN being off on *this* device is by far the likeliest cause, and
 * worth naming instead of a generic "connection failed".
 *
 * Kept deliberately narrow: an address that is not recognisably tailnet gets
 * the generic advice rather than a guess about Tailscale.
 */
export function isTailnetHost(host: string): boolean {
	const hostname = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
	if (!hostname) return false;

	// MagicDNS name, e.g. beelink-arch.tail4459c9.ts.net
	if (hostname.endsWith(".ts.net")) return true;

	// CGNAT range 100.64.0.0/10 - Tailscale's IPv4 addresses
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	if (v4) {
		const octets = v4.slice(1).map(Number);
		if (octets.some((n) => n > 255)) return false;
		return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
	}

	// Tailscale ULA fd7a:115c:a1e0::/48
	if (hostname === "fd7a:115c:a1e0::") return true;
	if (hostname.startsWith("fd7a:115c:a1e0:")) return true;

	return false;
}

/** The host this page is talking to, tolerant of a non-browser test context. */
export function currentHostIsTailnet(): boolean {
	if (typeof window === "undefined") return false;
	return isTailnetHost(window.location.hostname);
}
