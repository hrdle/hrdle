// `address` command - print where this server can be reached.
//
// The phone has to be told where this machine is, and the address is a Tailscale
// FQDN with a random-looking tailnet in the middle of it:
// `https://your-machine.tail4459c9.ts.net:5924`. Nobody memorises that, and
// typing it on a phone keyboard is the single worst moment of the setup - the
// glasses app's wizard spends a whole screen telling people to write it down.
//
// This used to draw the URL as a QR code, on the theory that a code removes the
// typing. It does not: the glasses app's WebView refuses a camera to web
// content, so the one screen that needed to read a code never could (measured
// on device; the table is in CLAUDE.md). What remains is the short form of the
// Tailscale IP - nine characters the setup screen accepts - and printing a code
// beside it only invited people to point a phone at something that would not be
// read. So this prints two lines of text and says which is for which.

import { IDENTITY } from '../../../shared/identity';
import { VERSION } from '../cli';
import { shortTailscaleIp } from '../services/discovery';

interface TailscaleStatus {
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
}

/**
 * This machine's Tailscale name, or null with the reason already printed.
 *
 * The same source the server itself uses to pick its certificate name, so what
 * is printed is necessarily the host the certificate was issued for. Deriving it
 * any other way - `hostname`, a config value - would produce an address that
 * resolves and then fails TLS, which is a worse failure than not printing one.
 */
function tailscaleSelf(): { host: string; ip: string | null } | null {
  const result = Bun.spawnSync(['tailscale', 'status', '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    console.error('error: Tailscale is not running, so this machine has no address to print.');
    console.error('  tailscale status');
    return null;
  }
  try {
    const status = JSON.parse(result.stdout.toString()) as TailscaleStatus;
    const dnsName = status.Self?.DNSName?.replace(/\.$/, '');
    if (!dnsName) {
      console.error('error: Tailscale reported no DNSName for this machine.');
      return null;
    }
    const ip = status.Self?.TailscaleIPs?.find((candidate) => candidate.includes('.')) ?? null;
    return { host: dnsName, ip };
  } catch {
    console.error('error: could not read the output of `tailscale status --json`.');
    return null;
  }
}

export function showAddress(port: number): void {
  const self = tailscaleSelf();
  if (!self) {
    process.exitCode = 1;
    return;
  }

  const url = `https://${self.host}:${port}`;
  const short = self.ip ? shortTailscaleIp(self.ip) : null;

  // The short form goes first when there is one. It is the answer to the
  // question that brought most people here - the glasses app is asking for an
  // address and will not take the FQDN's length on a phone keyboard - and the
  // URL below it is for the browser, which is a different errand.
  console.log('');
  console.log(`${IDENTITY.productName} v${VERSION}`);
  console.log('');
  if (short) {
    console.log(`  For the glasses app's setup screen:  ${short}`);
    console.log('');
  }
  console.log(`  In a browser on any device on your tailnet:  ${url}`);
  console.log('');
}
