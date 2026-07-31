/**
 * Web Push, so a notification does not depend on a browser tab being awake.
 *
 * Notifications reach the phone over the mux WebSocket and fire from the page,
 * which works exactly as long as the page is running. On Android it is usually
 * not: the tab is frozen when the screen goes off, its keepalive stops, and the
 * server cuts it as a zombie sixty seconds later. Measured on 2026-07-31 that
 * socket was opening and closing every couple of minutes, so most hook events
 * were broadcast to nobody. The glasses were the fallback, and the glasses app
 * is killed by its host every few minutes.
 *
 * A push is delivered by the operating system instead, whether or not anything
 * of ours is running.
 *
 * No account anywhere. VAPID means the keys are generated here and registered
 * with nobody; the browser chooses its own push service (FCM for Chrome,
 * Mozilla's for Firefox) and this only ever POSTs outbound to whatever endpoint
 * the subscription names. Nothing new listens on a port, and the payload is
 * encrypted to the subscription's own key, so the push service forwards bytes
 * it cannot read.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sendPushNotification } from '@mmmike/web-push/send';
import { generateVapidKeys } from '@mmmike/web-push/vapid';
import { atomicWriteFile, createMutationLock, ensureDataDir, getDataDir } from '../utils/storage';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Set when it was stored, so a stale list can be reasoned about. */
  createdAt: string;
  /** Free-text, from the browser. Only ever shown back to the user. */
  label?: string;
}

interface VapidKeys {
  subject: string;
  publicKey: string;
  privateKey: string;
}

const vapidPath = () => join(getDataDir(), 'push-vapid.json');
const subsPath = () => join(getDataDir(), 'push-subscriptions.json');

const vapidLock = createMutationLock();
const subsLock = createMutationLock();

let vapidCache: VapidKeys | null = null;

/**
 * The server's identity to the push services, made once and kept.
 *
 * Regenerating them invalidates every subscription in existence — the public
 * key is baked into what the browser subscribed with — so this reads before it
 * writes and the write is atomic and 0600. A private key that leaks lets
 * someone else push to the same subscribers.
 */
export async function getVapidKeys(): Promise<VapidKeys> {
  if (vapidCache) return vapidCache;
  return vapidLock(async () => {
    if (vapidCache) return vapidCache;
    try {
      const existing = JSON.parse(await readFile(vapidPath(), 'utf-8')) as VapidKeys;
      if (existing.publicKey && existing.privateKey) {
        vapidCache = existing;
        return existing;
      }
    } catch {
      // Not there yet, or unreadable — either way the next lines make a pair.
    }
    const pair = await generateVapidKeys();
    const keys: VapidKeys = {
      // The spec wants a contact for whoever runs the server; nothing reads it
      // back, and a push service only uses it to get in touch about abuse.
      subject: 'mailto:hrdle@localhost',
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
    };
    await ensureDataDir();
    await atomicWriteFile(vapidPath(), `${JSON.stringify(keys, null, 2)}\n`, 0o600);
    vapidCache = keys;
    return keys;
  });
}

/** What the browser needs to subscribe. The private half never leaves here. */
export async function getPublicKey(): Promise<string> {
  return (await getVapidKeys()).publicKey;
}

export async function listSubscriptions(): Promise<PushSubscriptionRecord[]> {
  try {
    const raw = JSON.parse(await readFile(subsPath(), 'utf-8'));
    return Array.isArray(raw) ? (raw as PushSubscriptionRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeSubscriptions(subs: PushSubscriptionRecord[]): Promise<void> {
  await ensureDataDir();
  await atomicWriteFile(subsPath(), `${JSON.stringify(subs, null, 2)}\n`, 0o600);
}

/**
 * Store a subscription, replacing any earlier one for the same endpoint.
 *
 * The endpoint is the identity: a browser that re-subscribes after clearing its
 * data gets a new one, and the old is left to be pruned when a push to it is
 * refused. Keyed any other way, one phone accumulates a row per visit.
 */
export async function addSubscription(sub: PushSubscriptionRecord): Promise<number> {
  return subsLock(async () => {
    const subs = (await listSubscriptions()).filter((s) => s.endpoint !== sub.endpoint);
    subs.push(sub);
    await writeSubscriptions(subs);
    return subs.length;
  });
}

export async function removeSubscription(endpoint: string): Promise<boolean> {
  return subsLock(async () => {
    const subs = await listSubscriptions();
    const left = subs.filter((s) => s.endpoint !== endpoint);
    if (left.length === subs.length) return false;
    await writeSubscriptions(left);
    return true;
  });
}

export interface PushNotificationInput {
  title: string;
  body: string;
  /** Where the notification should take the reader. The payload shape is fixed
   *  by the protocol library, so the session is carried in the query rather
   *  than as a free-form data bag; the service worker's click handler already
   *  reads `notify-session` from exactly this. */
  url?: string;
}

export interface PushResult {
  sent: number;
  /** Endpoints the push service said are gone, and which were dropped. */
  pruned: number;
  failed: number;
}

/**
 * Send to every stored subscription.
 *
 * A push service answers 404 or 410 for a subscription that no longer exists —
 * the app was uninstalled, the browser data cleared, the endpoint rotated — and
 * that is the only signal there is that a row is dead. Anything else (a 5xx, a
 * timeout, no network) is treated as this attempt failing rather than the
 * subscriber being gone, because dropping a real phone on a transient error
 * silences it permanently and nothing here would say why.
 */
export async function sendPush(input: PushNotificationInput): Promise<PushResult> {
  const subs = await listSubscriptions();
  if (subs.length === 0) return { sent: 0, pruned: 0, failed: 0 };
  const vapid = await getVapidKeys();
  const dead: string[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        // `false` means the push service says this subscription is gone (404 or
        // 410); anything it cannot complete throws. That is the same split this
        // needs, so it is taken as given rather than re-derived from a status.
        const ok = await sendPushNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          { title: input.title, body: input.body, url: input.url },
          vapid,
          { ttl: 60 },
        );
        if (ok) sent++;
        else dead.push(sub.endpoint);
      } catch (err) {
        failed++;
        console.warn('[push] send failed:', err);
      }
    }),
  );

  if (dead.length > 0) {
    await subsLock(async () => {
      const current = await listSubscriptions();
      await writeSubscriptions(current.filter((s) => !dead.includes(s.endpoint)));
    });
  }
  return { sent, pruned: dead.length, failed };
}

/** Test seam: forget the cached keys so a test can point at another data dir. */
export function resetPushCacheForTest(): void {
  vapidCache = null;
}
