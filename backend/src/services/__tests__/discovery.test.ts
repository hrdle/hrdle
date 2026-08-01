// The address arithmetic behind the short form.
//
// Three small functions, and every one of them is the kind that looks too
// obvious to test until it is wrong in production: the CGNAT range has an
// awkward boundary (100.64 through 100.127, not 100.0 through 100.255), the
// short form has to round-trip, and the expansion has to leave a hostname alone
// rather than turning it into something that looks like an address.

import { describe, expect, test } from 'bun:test';
import {
  expandTailscaleIp,
  isLocalAddress,
  shortTailscaleIp,
  startDiscoveryServer,
} from '../discovery';

describe('the door itself', () => {
  const info = {
    product: 'Hrdle',
    version: '0.0.0-test',
    url: 'https://beelink-arch.tail4459c9.ts.net:5924',
  };

  test('hands a loopback caller the address and nothing else', async () => {
    const server = startDiscoveryServer(0, info);
    expect(server).not.toBeNull();
    try {
      const res = await fetch(`http://127.0.0.1:${server?.port}/whoami`);
      expect(res.status).toBe(200);
      // The glasses app is on another origin and cannot relax this itself.
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toEqual(info);
    } finally {
      server?.stop();
    }
  });

  test('serves nothing but /whoami', async () => {
    // A signpost, not an API. Anything else here would be a second surface to
    // keep safe, in plaintext, for no benefit.
    const server = startDiscoveryServer(0, info);
    try {
      const res = await fetch(`http://127.0.0.1:${server?.port}/api/sessions`);
      expect(res.status).toBe(404);
    } finally {
      server?.stop();
    }
  });
});

describe('who the discovery door answers', () => {
  test('answers a tailnet caller', () => {
    // The whole point: a phone on the tailnet asking where this machine is.
    expect(isLocalAddress('100.91.210.90')).toBe(true);
    expect(isLocalAddress('100.64.0.1')).toBe(true);
    expect(isLocalAddress('100.127.255.254')).toBe(true);
  });

  test('does not mistake the rest of 100/8 for the tailnet', () => {
    // 100.64.0.0/10 is CGNAT; 100.0.x and 100.128.x upwards are ordinary public
    // space, and answering there would be announcing this server to the internet.
    expect(isLocalAddress('100.63.255.255')).toBe(false);
    expect(isLocalAddress('100.128.0.1')).toBe(false);
    expect(isLocalAddress('100.0.0.1')).toBe(false);
  });

  test('answers the private ranges and loopback', () => {
    expect(isLocalAddress('192.168.1.5')).toBe(true);
    expect(isLocalAddress('10.0.0.7')).toBe(true);
    expect(isLocalAddress('172.16.0.1')).toBe(true);
    expect(isLocalAddress('172.31.255.255')).toBe(true);
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('::1')).toBe(true);
  });

  test('does not answer 172.15 or 172.32, which are not private', () => {
    expect(isLocalAddress('172.15.0.1')).toBe(false);
    expect(isLocalAddress('172.32.0.1')).toBe(false);
  });

  test('answers Tailscale IPv6, which lives inside the ULA prefix', () => {
    expect(isLocalAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isLocalAddress('fe80::1')).toBe(true);
  });

  test('sees through an IPv4-mapped IPv6 address', () => {
    // Bun reports a v4 caller this way on a dual-stack socket, and taking it at
    // face value would refuse every tailnet phone.
    expect(isLocalAddress('::ffff:100.91.210.90')).toBe(true);
    expect(isLocalAddress('::ffff:8.8.8.8')).toBe(false);
  });

  test('refuses the public internet', () => {
    expect(isLocalAddress('8.8.8.8')).toBe(false);
    expect(isLocalAddress('2001:4860:4860::8888')).toBe(false);
  });
});

describe('the short form', () => {
  test('drops the part that is the same on every tailnet address', () => {
    expect(shortTailscaleIp('100.91.210.90')).toBe('91.210.90');
  });

  test('leaves a non-Tailscale address alone by refusing it', () => {
    // Shortening 192.168.1.5 to 168.1.5 would produce something that expands
    // back into a different machine entirely.
    expect(shortTailscaleIp('192.168.1.5')).toBeNull();
    expect(shortTailscaleIp('fd7a:115c:a1e0::1')).toBeNull();
  });
});

describe('expanding what was typed', () => {
  test('puts back the 100.', () => {
    expect(expandTailscaleIp('91.210.90')).toBe('100.91.210.90');
  });

  test('round-trips with the short form', () => {
    const full = '100.65.207.53';
    expect(expandTailscaleIp(shortTailscaleIp(full) as string)).toBe(full);
  });

  test('leaves a full address as it is', () => {
    expect(expandTailscaleIp('100.91.210.90')).toBe('100.91.210.90');
  });

  test('leaves a hostname as it is', () => {
    // MagicDNS resolves this on its own; prefixing it would be nonsense.
    expect(expandTailscaleIp('beelink-arch')).toBe('beelink-arch');
    expect(expandTailscaleIp('beelink-arch.tail4459c9.ts.net')).toBe('beelink-arch.tail4459c9.ts.net');
  });

  test('trims what a phone keyboard adds', () => {
    expect(expandTailscaleIp('  91.210.90 ')).toBe('100.91.210.90');
  });
});
