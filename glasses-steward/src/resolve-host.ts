// Turning what someone typed into the address the server is actually at.
//
// Carried over from the other glasses app, minus its translation table. The
// address is a Tailscale FQDN - `https://beelink-arch.tail4459c9.ts.net:5924` -
// forty-three characters off a terminal window across the room, onto a phone
// keyboard. Every attempt to avoid typing it has failed against this WebView:
// it refuses a camera to web content, refuses to open a file chooser, and
// refuses to read the clipboard. What it does do is accept typing.
//
// So the job is to make the typing short. The server answers a plaintext
// `/whoami` one port above its own, reachable by things a phone can be told in
// a few characters:
//
//   91.210.90     every Tailscale address starts 100., so that part is implied
//   beelink-arch  MagicDNS resolves a bare hostname inside the tailnet
//   100.91.210.90 the whole address, for anyone who prefers it
//
// Plaintext because HTTPS is exactly what cannot work here: the certificate is
// issued for the FQDN, so an IP or short name fails TLS and `fetch` has no way
// past a certificate error. The reply is the FQDN, and every request after this
// one is ordinary verified HTTPS.

/** A machine on the tailnet answers in milliseconds. Long enough to survive a
 *  phone waking its radio, short enough that a wrong address comes back as a
 *  mistake rather than a hang. */
const RESOLVE_TIMEOUT_MS = 4_000

/**
 * Put back the part of a Tailscale address that is always the same.
 *
 * `100.64.0.0/10` is the block Tailscale allocates from, so every address on
 * every tailnet starts `100.` - and nothing below that is shared. Three dotted
 * numbers is therefore exactly the short form; anything else is left alone,
 * because a hostname prefixed with `100.` is nonsense rather than an address.
 */
export function expandShortAddress(input: string): string {
  const trimmed = input.trim()
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? `100.${trimmed}` : trimmed
}

export function isFullUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim())
}

export interface ResolveOutcome {
  url?: string
  /** Something to show. Never a raw exception. */
  error?: string
}

function message(err: unknown): string {
  if (err instanceof Error) {
    // An abort is a timeout to everyone but the API that raised it.
    return err.name === 'AbortError' ? 'timed out' : err.message
  }
  return String(err)
}

/**
 * Resolve a typed address into the server's real one.
 *
 * Never throws: this runs behind a button on a setup screen, where an unhandled
 * rejection leaves a spinner turning for good.
 */
export async function resolveAddress(input: string): Promise<ResolveOutcome> {
  const raw = input.trim()
  if (!raw) return { error: 'Enter an address first.' }
  // A complete address needs no lookup, and this is the case a working paste
  // produces - so it stays the fastest path through.
  if (isFullUrl(raw)) return { url: raw.replace(/\/+$/, '') }

  // A port typed alongside the host belongs to the HTTPS server, not to this
  // door, so it is dropped rather than honoured.
  const host = expandShortAddress(raw).replace(/:\d+$/, '').replace(/\/.*$/, '')
  if (!host) return { error: 'Enter an address first.' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
  try {
    const res = await fetch(`http://${host}:${__DEFAULT_PORT__ + 1}/whoami`, {
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { error: `${host} answered, but not as ${__PRODUCT_NAME__}.` }
    const data = (await res.json()) as { url?: unknown }
    if (typeof data.url !== 'string' || !data.url) return { error: `${host} gave no address back.` }
    return { url: data.url }
  } catch (err) {
    return { error: `Could not reach ${host} (${message(err)}).` }
  } finally {
    clearTimeout(timer)
  }
}
