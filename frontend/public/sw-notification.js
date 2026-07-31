// Custom notification click handler for CC Hub PWA
// Version: 0.2.4-1

// Web Push. Delivered by the operating system, so it arrives whether or not a
// page of ours is running — which on Android is most of the time, because the
// tab is frozen when the screen goes off and the mux socket is cut a minute
// later. Everything below `notificationclick` already knows what to do with the
// data, so a push reuses it exactly.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A push with an unreadable body is still worth showing: something
    // happened, and saying nothing is the failure this replaced.
  }
  const title = payload.title || 'Hrdle';
  // The payload shape is fixed by the protocol library to title/body/url/tag,
  // so the session travels in the url's query. Unpacked here into the same
  // `data` the click handler below has always read, which is why that handler
  // needs no change at all.
  let sessionId;
  try {
    sessionId = new URL(payload.url || '/', self.location.origin).searchParams.get(
      'notify-session',
    );
  } catch {
    sessionId = null;
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icon-192.png',
      // Unique per push: a shared tag makes the newest replace the last, and
      // two agents finishing a minute apart are two things worth seeing.
      tag: `push-${Date.now()}`,
      data: sessionId ? { sessionId } : {},
    }),
  );
});

// The endpoint a subscription names can be rotated by the push service, and
// when it is, the old one stops delivering silently. Re-subscribing with the
// same key and telling the server is the only way back.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const key = old && old.options ? old.options.applicationServerKey : null;
      if (!key || !old.endpoint) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      // `/renew` rather than `/subscribe`: a worker has no access to the token
      // the page holds, and naming the endpoint being replaced is what stands
      // in for it. Refreshes a known device; cannot add a new one.
      await fetch('/api/push/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldEndpoint: old.endpoint, subscription: sub.toJSON() }),
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const peerId = event.notification.data?.peerId;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Send log to all clients so it appears in frontend.log
      for (const c of clientList) {
        c.postMessage({ type: 'sw-log', message: `[SW v0.2.4-1] notificationclick sessionId=${sessionId} peerId=${peerId} clients=${clientList.length}` });
      }
      const client = clientList.find((candidate) => 'focus' in candidate);
      if (client) {
        if (sessionId) {
          client.postMessage({ type: 'notification-click', sessionId, peerId });
        }
        return client.focus();
      }
      if (self.clients.openWindow) {
        const params = new URLSearchParams();
        if (sessionId) params.set('notify-session', sessionId);
        if (peerId) params.set('notify-peer', peerId);
        const url = params.size > 0 ? `/?${params.toString()}` : '/';
        return self.clients.openWindow(url);
      }
    })
  );
});

// Log when this script is loaded
self.addEventListener('activate', () => {
  self.clients.matchAll({ type: 'window' }).then((clients) => {
    for (const c of clients) {
      c.postMessage({ type: 'sw-log', message: '[SW v0.2.4-1] activated' });
    }
  });
});
