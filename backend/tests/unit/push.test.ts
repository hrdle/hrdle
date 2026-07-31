// Web Push: keys, the subscription list, and what a failed send means.
//
// The point of the feature is that a notification survives the page not being
// there. On Android the tab freezes when the screen goes off, its keepalive
// stops, and the server cuts the socket sixty seconds later — measured on
// 2026-07-31 the phone's socket was opening and closing every couple of
// minutes, so most hook events were broadcast to nobody. Everything below is
// the part of that path that can be asserted without a browser.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../shared/identity';

// Through identity rather than spelled out: the rename in #459 is the reason
// there is a test guarding exactly this, and a literal here would survive the
// next one silently.
const DATA_DIR_ENV = IDENTITY.dataDirEnv;
const dir = await mkdtemp(join(tmpdir(), `${IDENTITY.binaryName}-push-`));
const prevEnv = process.env[DATA_DIR_ENV];
process.env[DATA_DIR_ENV] = dir;

const {
  addSubscription,
  getPublicKey,
  getVapidKeys,
  listSubscriptions,
  removeSubscription,
  sendPush,
} = await import('../../src/services/push');

afterAll(async () => {
  if (prevEnv === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = prevEnv;
  await rm(dir, { recursive: true, force: true });
});

/**
 * A subscription with real crypto material.
 *
 * `p256dh` has to be an actual point on P-256: the payload is encrypted by
 * doing ECDH against it, so a string of the right length is not enough — the
 * send fails before it reaches the network and every assertion about status
 * codes measures the wrong thing.
 */
const b64url = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const subKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
  'deriveBits',
]);
const P256DH = b64url(await crypto.subtle.exportKey('raw', subKeyPair.publicKey));
const AUTH = b64url(crypto.getRandomValues(new Uint8Array(16)).buffer);

function sub(endpoint: string) {
  return {
    endpoint,
    keys: { p256dh: P256DH, auth: AUTH },
    createdAt: new Date().toISOString(),
  };
}

describe('VAPID keys are made once and kept', () => {
  test('a keypair appears on first use', async () => {
    const keys = await getVapidKeys();
    expect(keys.publicKey.length).toBeGreaterThan(80);
    expect(keys.privateKey.length).toBeGreaterThan(20);
    expect(keys.subject).toStartWith('mailto:');
  });

  test('the same pair comes back next time', async () => {
    // Regenerating invalidates every subscription in existence — the public key
    // is baked into what the browser subscribed with — so this is the whole
    // reason the file exists.
    const a = await getVapidKeys();
    const b = await getVapidKeys();
    expect(b.publicKey).toBe(a.publicKey);
    expect(b.privateKey).toBe(a.privateKey);
  });

  test('the private half is written 0600', async () => {
    const mode = (await stat(join(dir, 'push-vapid.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('only the public half is offered to callers', async () => {
    const pub = await getPublicKey();
    const keys = await getVapidKeys();
    expect(pub).toBe(keys.publicKey);
    expect(pub).not.toContain(keys.privateKey);
  });
});

describe('the subscription list', () => {
  test('an empty list before anything subscribes', async () => {
    expect(await listSubscriptions()).toEqual([]);
  });

  test('a subscription is stored and read back', async () => {
    await addSubscription(sub('https://fcm.googleapis.com/fcm/send/aaa'));
    const all = await listSubscriptions();
    expect(all).toHaveLength(1);
    expect(all[0].endpoint).toEndWith('/aaa');
  });

  test('the same endpoint replaces rather than duplicates', async () => {
    // A phone that reloads the page re-subscribes every time. Keyed any other
    // way, one device accumulates a row per visit and gets a notification per
    // row.
    await addSubscription(sub('https://fcm.googleapis.com/fcm/send/aaa'));
    expect(await listSubscriptions()).toHaveLength(1);
  });

  test('a different endpoint is a different device', async () => {
    await addSubscription(sub('https://updates.push.services.mozilla.com/wpush/v2/bbb'));
    expect(await listSubscriptions()).toHaveLength(2);
  });

  test('removing takes exactly one', async () => {
    expect(await removeSubscription('https://fcm.googleapis.com/fcm/send/aaa')).toBe(true);
    const all = await listSubscriptions();
    expect(all).toHaveLength(1);
    expect(all[0].endpoint).toContain('mozilla');
  });

  test('removing something absent is not an error', async () => {
    expect(await removeSubscription('https://example.com/gone')).toBe(false);
  });

  test('the list is written 0600 too', async () => {
    // Endpoints are bearer-ish: anyone holding one can push to that device.
    const mode = (await stat(join(dir, 'push-subscriptions.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('sending', () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test('nothing subscribed is not an error and sends nothing', async () => {
    const before = await listSubscriptions();
    for (const s of before) await removeSubscription(s.endpoint);
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response('', { status: 201 });
    }) as unknown as typeof fetch;
    expect(await sendPush({ title: 't', body: 'b' })).toEqual({ sent: 0, pruned: 0, failed: 0 });
    expect(called).toBe(0);
  });

  test('a 410 prunes the subscription', async () => {
    // The only signal a push service gives that a row is dead: the app was
    // uninstalled, the browser data cleared, the endpoint rotated.
    await addSubscription(sub('https://fcm.googleapis.com/fcm/send/dead'));
    globalThis.fetch = (async () => new Response('', { status: 410 })) as unknown as typeof fetch;
    const r = await sendPush({ title: 't', body: 'b' });
    expect(r).toEqual({ sent: 0, pruned: 1, failed: 0 });
    expect(await listSubscriptions()).toHaveLength(0);
  });

  test('a 500 counts as failed and keeps the subscription', async () => {
    // Dropping a real phone on a transient error silences it permanently, and
    // nothing here would ever say why.
    await addSubscription(sub('https://fcm.googleapis.com/fcm/send/flaky'));
    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const r = await sendPush({ title: 't', body: 'b' });
    expect(r).toEqual({ sent: 0, pruned: 0, failed: 1 });
    expect(await listSubscriptions()).toHaveLength(1);
  });

  test('a thrown request counts as failed, not as gone', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await sendPush({ title: 't', body: 'b' });
    expect(r.failed).toBe(1);
    expect(r.pruned).toBe(0);
    expect(await listSubscriptions()).toHaveLength(1);
  });

  test('a 201 is a delivery, and the body is encrypted', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response('', { status: 201 });
    }) as unknown as typeof fetch;
    const r = await sendPush({ title: '~/repos/hrdle', body: 'Response complete' });
    expect(r).toEqual({ sent: 1, pruned: 0, failed: 0 });
    expect(seen!.url).toContain('/flaky');
    const headers = seen!.init.headers as Record<string, string>;
    expect(String(headers.Authorization ?? headers.authorization)).toStartWith('vapid ');
    // RFC 8291, not the superseded `aesgcm` draft: the first library tried here
    // implemented the old one, and a push service dropping it later would take
    // every notification with it.
    expect(String(headers['Content-Encoding'] ?? headers['content-encoding'])).toBe('aes128gcm');
    // The push service forwards bytes it cannot read; the body must not be
    // sitting in them in the clear.
    const body = new TextDecoder().decode(seen!.init.body as ArrayBuffer);
    expect(body).not.toContain('Response complete');
  });
});
