/**
 * Web Push subscriptions.
 *
 * A browser subscribes with the server's public VAPID key and hands back an
 * endpoint its push service chose, plus two keys the payload gets encrypted to.
 * That triple is all a push needs, and it is what is stored.
 *
 * Behind auth, unlike `/api/notify` and the glasses relay: those are called by
 * local hooks and by the glasses app, whereas this is a browser asking to be
 * added to the list of devices the server pushes to. An unauthenticated caller
 * being able to add one would mean anyone who can reach the port gets a copy of
 * every notification.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  addSubscription,
  getPublicKey,
  listSubscriptions,
  removeSubscription,
} from '../services/push';

const push = new Hono();

/** The shape `PushSubscription.toJSON()` produces, narrowed to what is used. */
const SubscriptionSchema = z.object({
  // Length via refine rather than `.max()`, which Zod 4 deprecates on a URL.
  endpoint: z.url().refine((u) => u.length <= 2048, 'endpoint too long'),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
  label: z.string().max(120).optional(),
});

/** The public half, so a browser can subscribe. Safe to hand out — it is the
 *  key the subscription is made against and is public by design. */
push.get('/key', async (c) => {
  return c.json({ publicKey: await getPublicKey() });
});

push.get('/subscriptions', async (c) => {
  // Endpoints identify a device and are bearer-ish: anyone holding one can be
  // pushed to. Only the count and the labels leave here.
  const subs = await listSubscriptions();
  return c.json({
    count: subs.length,
    subscriptions: subs.map((s) => ({
      label: s.label,
      createdAt: s.createdAt,
      host: (() => {
        try {
          return new URL(s.endpoint).host;
        } catch {
          return 'unknown';
        }
      })(),
    })),
  });
});

push.post('/subscribe', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const parsed = SubscriptionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid subscription', detail: parsed.error.issues[0]?.message }, 400);
  }
  const count = await addSubscription({
    endpoint: parsed.data.endpoint,
    keys: parsed.data.keys,
    label: parsed.data.label,
    createdAt: new Date().toISOString(),
  });
  return c.json({ ok: true, count });
});

/**
 * Replace a subscription whose endpoint the push service rotated.
 *
 * Outside the auth glob, because the caller is a service worker and a worker
 * cannot read the token the page keeps in localStorage. What stands in for the
 * password is having to name the endpoint being replaced: endpoints carry a
 * long unguessable token, they are never handed out by this API (`/subscriptions`
 * returns only the host), and an unknown one is refused. So this can refresh a
 * device that was authenticated once, and cannot add a new one.
 */
push.post('/renew', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const parsed = z
    .object({ oldEndpoint: z.string().min(1), subscription: SubscriptionSchema })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid renewal' }, 400);

  const known = (await listSubscriptions()).some((s) => s.endpoint === parsed.data.oldEndpoint);
  if (!known) return c.json({ error: 'unknown subscription' }, 404);

  await removeSubscription(parsed.data.oldEndpoint);
  await addSubscription({
    endpoint: parsed.data.subscription.endpoint,
    keys: parsed.data.subscription.keys,
    label: parsed.data.subscription.label,
    createdAt: new Date().toISOString(),
  });
  return c.json({ ok: true });
});

push.post('/unsubscribe', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const endpoint = (body as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    return c.json({ error: 'endpoint required' }, 400);
  }
  const removed = await removeSubscription(endpoint);
  return c.json({ ok: true, removed });
});

export { push };
