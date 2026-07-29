// PoC: can the hrdle backend (Bun) drive the herdr socket API directly?
//
// What it checks:
//   1. NDJSON requests over the Unix socket (pane.get / pane.read / pane.send_text)
//   2. Push events via events.subscribe (connection held open)
//   3. Assembling a PaneViewport-shaped object (lines + scroll metrics)
//
// Run: bun run poc/herdr/poc-client.ts <pane_id>
//   (herdr server must be running and the pane must exist)

import { connect } from "node:net";
import { homedir } from "node:os";

const SOCKET_PATH = `${homedir()}/.config/herdr/herdr.sock`;
const paneId = process.argv[2] ?? "w1:p1";

interface HerdrResponse {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

// herdr uses one connection per request (everything but subscribe disconnects after the reply)
function rpc(method: string, params: Record<string, unknown>): Promise<HerdrResponse> {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET_PATH);
    let buf = "";
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ id: "poc", method, params })}\n`);
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    sock.on("error", reject);
  });
}

// events.subscribe holds the connection open and streams push events
function subscribe(
  subscriptions: Array<Record<string, unknown>>,
  onEvent: (ev: Record<string, unknown>) => void,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET_PATH);
    let buf = "";
    let acked = false;
    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions } })}\n`,
      );
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line);
        if (!acked) {
          acked = true;
          resolve(() => sock.end());
        } else {
          onEvent(msg);
        }
      }
    });
    sock.on("error", reject);
  });
}

// ---- Assembling a PaneViewport equivalent (mirrors PaneViewport in shared/types.ts) ----
interface PocViewport {
  paneId: string;
  cols: number;
  rows: number;
  lines: string[]; // with ANSI
  historySize: number; // max_offset_from_bottom
  offset: number;
  atTail: boolean;
  cursor: null; // herdr pane.read returns no cursor info (a known gap)
}

async function captureViewport(pane: string, offset: number, rows: number): Promise<PocViewport> {
  const info = await rpc("pane.get", { pane_id: pane });
  const paneInfo = (info.result as any).pane;
  const scroll = paneInfo.scroll as {
    offset_from_bottom: number;
    max_offset_from_bottom: number;
    viewport_rows: number;
  };

  // Offset paging: read the trailing (offset + rows) lines and slice the first rows out
  // Constraint: pane.read caps at 1000 lines, so offset + rows <= 1000
  const want = Math.min(offset + rows, 1000);
  const read = await rpc("pane.read", {
    pane_id: pane,
    source: "recent",
    lines: want,
    format: "ansi",
    strip_ansi: false,
  });
  const text = (read.result as any).read.text as string;
  const all = text.split("\n");
  const sliceStart = Math.max(0, all.length - offset - rows);
  const lines = all.slice(sliceStart, sliceStart + rows);

  return {
    paneId: pane,
    cols: 0, // available from the layout API (rect.width of pane.layout)
    rows,
    lines,
    historySize: scroll.max_offset_from_bottom,
    offset,
    atTail: offset === 0,
    cursor: null,
  };
}

// ---- 検証実行 ----
console.log("=== 1. pane.get (scroll metrics) ===");
const g = await rpc("pane.get", { pane_id: paneId });
if (g.error) {
  console.error("pane.get failed:", g.error);
  process.exit(1);
}
console.log(JSON.stringify((g.result as any).pane.scroll));

console.log("\n=== 2. events.subscribe (push受信) ===");
const events: string[] = [];
const unsub = await subscribe(
  [{ type: "pane.agent_status_changed" }, { type: "pane.created" }, { type: "pane.closed" }],
  (ev) => events.push(JSON.stringify(ev).slice(0, 120)),
);
console.log("subscribed OK (connection held)");

console.log("\n=== 3. viewport at offset=0 (live edge) ===");
const live = await captureViewport(paneId, 0, 5);
console.log(`historySize=${live.historySize} atTail=${live.atTail}`);
for (const l of live.lines) console.log(`  | ${JSON.stringify(l.slice(0, 60))}`);

console.log("\n=== 4. viewport at offset=100 (scrollback paging) ===");
const back = await captureViewport(paneId, 100, 5);
for (const l of back.lines) console.log(`  | ${JSON.stringify(l.slice(0, 60))}`);

console.log("\n=== 5. input round-trip (send_text + enter) ===");
await rpc("pane.send_text", { pane_id: paneId, text: 'echo "PoC done"' });
await rpc("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
await new Promise((r) => setTimeout(r, 800));
const after = await captureViewport(paneId, 0, 5);
const found = after.lines.some((l) => l.includes("PoC done"));
console.log(`echo round-trip: ${found ? "OK" : "NG"}`);

unsub();
console.log(`\nreceived push events: ${events.length}`);
for (const e of events) console.log(`  ${e}`);

console.log("\n=== PoC done ===");
process.exit(found ? 0 : 1);
