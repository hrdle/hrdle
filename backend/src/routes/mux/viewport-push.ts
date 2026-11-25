import type { ServerWebSocket } from 'bun';
import { captureViewportHerdr, type HerdrControlSession } from '../../services/herdr-control';
import type { MuxData, MuxSubscription } from './connections';

// Output → push debounce. Wait this long after the last %output for a pane
// before recapturing. Shorter = lower latency; longer = fewer captures.
const PUSH_DEBOUNCE_MS = 50;

// Hard rate limit per pane per subscription. Live-mode clients receive at
// most one unsolicited viewport push per this window. Each push runs
// display-message + capture-pane + ~10KB JSON, so removing the cap let a
// continuously-redrawing pane consume runaway CPU.
// 200ms = 5/sec/pane.
const PUSH_MIN_INTERVAL_MS = 200;

const DEBUG_MUX = process.env.DEBUG_MUX === '1' || process.env.DEBUG_MUX === 'true';

export function schedulePush(
  ws: ServerWebSocket<MuxData>,
  sessionId: string,
  sub: MuxSubscription,
  paneId: string,
) {
  if (sub.pushTimers.has(paneId)) return;
  const lastAt = sub.lastPushAt.get(paneId) ?? 0;
  const sinceLast = Date.now() - lastAt;
  const delay = Math.max(PUSH_DEBOUNCE_MS, PUSH_MIN_INTERVAL_MS - sinceLast);
  const timer = setTimeout(() => {
    sub.pushTimers.delete(paneId);
    void pushViewport(ws, sessionId, sub, paneId, 0);
  }, delay);
  sub.pushTimers.set(paneId, timer);
}

export async function pushViewport(
  ws: ServerWebSocket<MuxData>,
  sessionId: string,
  sub: MuxSubscription,
  paneId: string,
  offset: number,
) {
  if (sub.controlSession.isDestroyed) return;
  let viewport: Awaited<ReturnType<typeof captureViewportHerdr>> = null;
  try {
    viewport = await captureViewportHerdr(sub.controlSession, paneId, offset);
  } catch (err) {
    console.warn(`[mux] captureViewport failed for ${paneId}:`, err);
    return;
  }
  if (!viewport) return;

  sub.knownPanes.add(paneId);
  if (DEBUG_MUX) {
    console.log(`[mux] viewport pane=${paneId} offset=${viewport.offset}/${viewport.historySize} rows=${viewport.rows}`);
  }
  try {
    ws.send(JSON.stringify({ type: 'viewport', sessionId, viewport }));
  } catch { return; }
  sub.lastPushAt.set(paneId, Date.now());
}

export async function emitInitialViewports(
  ws: ServerWebSocket<MuxData>,
  sessionId: string,
  sub: MuxSubscription,
) {
  let panes: Awaited<ReturnType<HerdrControlSession['listPanes']>> = [];
  try {
    panes = await sub.controlSession.listPanes();
  } catch (err) {
    console.warn(`[mux] listPanes failed for ${sessionId}:`, err);
    return;
  }
  for (const pane of panes) {
    sub.liveOffset.set(pane.paneId, 0);
    await pushViewport(ws, sessionId, sub, pane.paneId, 0);
  }
}
