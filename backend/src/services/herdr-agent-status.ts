/**
 * Live agent-status watcher.
 *
 * herdr knows the moment an agent starts working, finishes, or gets stuck on a
 * prompt. Without this, the UI only learns about it on the next 5s sessions
 * push. Subscribing turns that into an immediate push.
 *
 * The watcher owns no state: it decides *when* to rebuild the session list, not
 * what's in it. Status values still come from `pane.list` at build time, so a
 * dropped event costs latency (until the next 5s tick), never correctness.
 *
 * `pane.agent_status_changed` is a per-pane subscription (`pane_id` required,
 * verified against `herdr api schema`, protocol 16), so the pane set has to be
 * re-subscribed as panes come and go — hence the lifecycle subscriptions.
 */

import { herdrSubscribe, listPanes } from './herdr-client';

/**
 * herdr's event naming is asymmetric across three surfaces (verified live
 * against herdr 0.7.4 / protocol 16):
 *   1. Subscription *request* types are dotted — `events.subscribe` rejects
 *      anything else (`unknown variant "pane_created"`).
 *   2. Received lifecycle events echo back in snake_case (`pane_created`).
 *   3. The received per-pane status event stays dotted
 *      (`pane.agent_status_changed`).
 * So the request list must stay dotted, while classification of *received*
 * events has to accept both forms — hence the `.`→`_` normalization below.
 */
const LIFECYCLE_SUBSCRIPTION_TYPES = [
  'pane.created',
  'pane.closed',
  'pane.exited',
  'pane.agent_detected',
];
const LIFECYCLE_EVENT_NAMES = new Set([
  'pane_created',
  'pane_closed',
  'pane_exited',
  'pane_agent_detected',
]);

/** Classify a *received* herdr event, normalizing its two namings to snake_case. */
export function classifyHerdrEvent(rawEvent: unknown): 'status' | 'lifecycle' | 'ignore' {
  if (typeof rawEvent !== 'string') return 'ignore';
  const kind = rawEvent.replace(/\./g, '_');
  if (kind === 'pane_agent_status_changed') return 'status';
  if (LIFECYCLE_EVENT_NAMES.has(kind)) return 'lifecycle';
  return 'ignore';
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Should a lifecycle event trigger a full resubscribe (rebuild of the per-pane
 * `pane.agent_status_changed` subscriptions)? Only when the *actual* pane set —
 * `pane.list`, the ground truth — differs from what we're subscribed to, or
 * when there's no live subscription to keep.
 *
 * Crucially this ignores the event payload. herdr replays lifecycle events on
 * every `events.subscribe` (a snapshot), and its replay buffer can hold a
 * *phantom* `pane_created` for a pane that `pane.list`, `workspace.list` and
 * `pane.get` all agree no longer exists (observed live: `w2N:p1`). The old code
 * resubscribed on any such event; each resubscribe opened a fresh stream that
 * drew the same phantom again — a ~2.5/s busy loop (one `pane.list` RPC + socket
 * teardown per turn). An event-payload gate can't fix it: the phantom pane never
 * appears in `pane.list`, so it reads as "new" forever. Diffing `pane.list`
 * against the subscribed set makes phantoms and echoes no-ops while still
 * catching genuine adds/removes.
 */
export function paneSetRequiresResubscribe(
  nextPaneIds: ReadonlySet<string>,
  subscribedPaneIds: ReadonlySet<string>,
  hasLiveSubscription: boolean,
): boolean {
  if (!hasLiveSubscription) return true;
  return !setsEqual(nextPaneIds, subscribedPaneIds);
}

const CHANGE_DEBOUNCE_MS = 150;
const RESUBSCRIBE_DEBOUNCE_MS = 400;
/** Backoff after a dropped/rejected subscription. herdr restarts land here. */
const RETRY_DELAY_MS = 5_000;

let unsubscribe: (() => void) | null = null;
/** Pane ids our live subscription covers — diffed against pane.list to decide
 *  whether a lifecycle event is a genuine change or a replay/phantom. */
let subscribedPaneIds: Set<string> = new Set();
let running = false;
let changeTimer: ReturnType<typeof setTimeout> | null = null;
let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
  if (t) clearTimeout(t);
  return null;
}

/** Coalesce bursts: a turn ending fires status + output events together. */
function scheduleChangePush(): void {
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    // One listener throwing must not silence the others.
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[herdr-status] listener failed:', err);
      }
    }
  }, CHANGE_DEBOUNCE_MS);
}

function scheduleResubscribe(): void {
  if (resubscribeTimer) return;
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null;
    void subscribeToPanes();
  }, RESUBSCRIBE_DEBOUNCE_MS);
}

function scheduleRetry(): void {
  if (retryTimer || !running) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void subscribeToPanes();
  }, RETRY_DELAY_MS);
}

async function subscribeToPanes(): Promise<void> {
  if (!running) return;

  let panes: Awaited<ReturnType<typeof listPanes>>;
  try {
    panes = await listPanes();
  } catch {
    scheduleRetry(); // herdr down / restarting — the 5s poll covers us meanwhile
    return;
  }
  if (!running) return;

  // A lifecycle event schedules us, but the pane set may be unchanged — a herdr
  // snapshot replay or the phantom `pane_created` (see paneSetRequiresResubscribe).
  // Keep the live stream open in that case: tearing it down and reopening is what
  // draws the next replay and sustains the loop.
  const nextPaneIds = new Set(panes.map((p) => p.pane_id));
  if (!paneSetRequiresResubscribe(nextPaneIds, subscribedPaneIds, unsubscribe !== null)) {
    return;
  }

  unsubscribe?.();
  unsubscribe = null;
  subscribedPaneIds = nextPaneIds;

  const subscriptions: Array<Record<string, unknown>> = [
    ...LIFECYCLE_SUBSCRIPTION_TYPES.map((type) => ({ type })),
    ...panes.map((p) => ({ type: 'pane.agent_status_changed', pane_id: p.pane_id })),
  ];

  unsubscribe = herdrSubscribe(
    subscriptions,
    (ev) => {
      const kind = classifyHerdrEvent(ev.event);
      if (kind === 'status') {
        scheduleChangePush();
      } else if (kind === 'lifecycle') {
        // Re-check pane.list (debounced) and rebuild only if the set genuinely
        // changed. Push either way — pane state is user-visible regardless.
        scheduleResubscribe();
        scheduleChangePush();
      }
    },
    () => {
      unsubscribe = null;
      scheduleRetry();
    },
  );
}

/**
 * Watch until the returned function is called. `listener` fires (debounced)
 * whenever herdr reports an agent status change or a pane appears/disappears.
 *
 * More than one listener, because the two callers stop for different reasons:
 * the session push only matters while a browser is connected, while the steward
 * has to keep being woken precisely when nobody is watching a screen.
 */
export function addAgentStatusListener(listener: () => void): () => void {
  listeners.add(listener);
  if (!running) {
    running = true;
    void subscribeToPanes();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) teardown();
  };
}

function teardown(): void {
  running = false;
  unsubscribe?.();
  unsubscribe = null;
  subscribedPaneIds = new Set();
  changeTimer = clearTimer(changeTimer);
  resubscribeTimer = clearTimer(resubscribeTimer);
  retryTimer = clearTimer(retryTimer);
}

let removeSessionPushListener: (() => void) | null = null;

/** Idempotent single-listener form, for the session push. */
export function startAgentStatusWatcher(onChange: () => void): void {
  if (removeSessionPushListener) return;
  removeSessionPushListener = addAgentStatusListener(onChange);
}

export function stopAgentStatusWatcher(): void {
  removeSessionPushListener?.();
  removeSessionPushListener = null;
}
