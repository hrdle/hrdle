// `qr` command - print the server's URL as a QR code.
//
// The phone has to be told where this machine is, and the address is a Tailscale
// FQDN with a random-looking tailnet in the middle of it:
// `https://your-machine.tail4459c9.ts.net:5924`. Nobody memorises that, and
// typing it on a phone keyboard is the single worst moment of the setup - the
// glasses app's wizard spends a whole screen telling people to write it down.
//
// A QR code removes the typing. The terminal renderer is the point: the person
// is already looking at this shell, having just run `setup`, and a code drawn
// here needs no web page, no clipboard and no second device to bridge them.

import QRCode from 'qrcode';
import { IDENTITY } from '../../../shared/identity';
import { VERSION } from '../cli';
import { shortTailscaleIp } from '../services/discovery';

interface TailscaleStatus {
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
}

/**
 * This machine's Tailscale name, or null with the reason already printed.
 *
 * The same source the server itself uses to pick its certificate name, so the
 * QR necessarily carries the host the certificate was issued for. Deriving it
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

export async function showQr(port: number): Promise<void> {
  const self = tailscaleSelf();
  if (!self) {
    process.exitCode = 1;
    return;
  }

  const url = `https://${self.host}:${port}`;

  // Error correction stays at the lowest level on purpose. It is the setting
  // that decides how big the code is, and this one is read off a terminal by a
  // phone held a foot away - not printed on a box and scanned in a warehouse.
  // A denser code at level M would wrap in an 80-column window, and a QR code
  // that does not fit the screen is unreadable in a way no redundancy fixes.
  const qr = await QRCode.toString(url, {
    type: 'terminal',
    small: true,
    errorCorrectionLevel: 'L',
  });

  console.log('');
  console.log(`${IDENTITY.productName} v${VERSION}`);
  console.log('');
  console.log(qr);
  console.log(`  ${url}`);
  console.log('');
  console.log(`  Scan this with your phone's own camera app - it opens ${IDENTITY.productName}`);
  console.log('  in the browser. The glasses app cannot use a camera: its WebView');
  console.log('  refuses one to web content.');
  const short = self.ip ? shortTailscaleIp(self.ip) : null;
  if (short) {
    console.log('');
    console.log(`  For the glasses app's setup screen, type this instead:  ${short}`);
  }
  console.log('');
}
