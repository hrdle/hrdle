import type { ServerWebSocket } from 'bun';
import type { GlassesScreen } from '../../../../shared/types';
import { recordGlassesScreen } from '../../services/glasses-screen-recorder';
import { activeMuxConnections, type MuxData } from './connections';

// ── Glasses screen mirror ──
//
// The device publishes the three strings it just drew; browsers render them
// with the simulator's own painter. Last frame is retained so a viewer joining
// mid-demo sees the current screen instead of a blank panel until the next
// render.

let lastGlassesScreen: GlassesScreen | null = null;
let glassesScreenPublisher: ServerWebSocket<MuxData> | null = null;


function sendGlassesScreen(ws: ServerWebSocket<MuxData>, screen: GlassesScreen | null) {
  try { ws.send(JSON.stringify({ type: 'glasses-screen', screen })); } catch { /* disconnected */ }
}

function broadcastGlassesScreen(screen: GlassesScreen | null) {
  for (const client of activeMuxConnections) {
    if (client.data.watchesGlassesScreen) sendGlassesScreen(client, screen);
  }
}

/** A frame the device just drew: kept for viewers who join later, recorded,
 *  and sent to every open mirror. */
export function publishGlassesScreen(ws: ServerWebSocket<MuxData>, screen: GlassesScreen): void {
  lastGlassesScreen = screen;
  glassesScreenPublisher = ws;
  // Demo recording taps the stream here, before the viewer check:
  // it must see every frame whether or not a mirror is open.
  recordGlassesScreen(screen);
  broadcastGlassesScreen(screen);
}

/** A viewer opening the mirror gets the current frame straight away. */
export function watchGlassesScreen(ws: ServerWebSocket<MuxData>): void {
  ws.data.watchesGlassesScreen = true;
  sendGlassesScreen(ws, lastGlassesScreen);
}

/** The publisher going away must reach the viewers: a mirror that keeps
 *  showing the last frame is indistinguishable from a live one that has
 *  stopped changing. */
export function releaseGlassesScreen(ws: ServerWebSocket<MuxData>): void {
  if (glassesScreenPublisher !== ws) return;
  glassesScreenPublisher = null;
  lastGlassesScreen = null;
  recordGlassesScreen(null);
  broadcastGlassesScreen(null);
}
