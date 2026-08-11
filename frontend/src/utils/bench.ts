import { storageKey } from "./app-storage";
/**
 * End-to-end terminal latency bench.
 *
 * Activate by running `__hrdle_bench.start()` in DevTools console (or by
 * setting localStorage 'hrdle-bench' = '1' before reload). When active, every
 * WS frame and every xterm `term.write` is sampled. The bench also watches
 * the incoming byte stream for the marker `__BENCH_END__` and prints a
 * summary report when it is seen.
 *
 * Recommended usage:
 *   1. Open the dev backend (devPort from identity.json) on a PC and open the DevTools console
 *   2. Run `__hrdle_bench.start()`
 *   3. In any session:
 *        cat /tmp/bench-color.txt; echo __BENCH_END__
 *   4. The summary prints to the console
 */

interface FrameSample {
	/** When the WebSocket onmessage arrived (performance.now) */
	recvT: number;
	/** Byte count (payload only) */
	bytes: number;
}

interface WriteSample {
	/** Time right before term.write is called */
	startT: number;
	/** Time of xterm's write callback (parsing done) */
	endT: number;
	/** Bytes written */
	bytes: number;
}

interface BenchState {
	active: boolean;
	startT: number;
	frames: FrameSample[];
	writes: WriteSample[];
	endMarkerSeenAt: number | null;
}

const END_MARKER = "__BENCH_END__";
const END_MARKER_BYTES = new TextEncoder().encode(END_MARKER);

const state: BenchState = {
	active: false,
	startT: 0,
	frames: [],
	writes: [],
	endMarkerSeenAt: null,
};

function isActive(): boolean {
	return state.active;
}

function start(): void {
	state.active = true;
	state.startT = performance.now();
	state.frames = [];
	state.writes = [];
	state.endMarkerSeenAt = null;
	console.log(`[bench] started — emit \`${END_MARKER}\` to finalize`);
}

function stop(): void {
	state.active = false;
	report();
}

function recordFrame(bytes: number): void {
	if (!state.active) return;
	state.frames.push({ recvT: performance.now(), bytes });
}

function recordWriteStart(): number {
	return state.active ? performance.now() : 0;
}

function recordWriteEnd(startT: number, bytes: number): void {
	if (!state.active || startT === 0) return;
	state.writes.push({ startT, endT: performance.now(), bytes });
}

/**
 * Scan an incoming byte slice for END_MARKER. When seen, finalize and report.
 * Uses a small ring of "recent bytes" to handle markers that span frames.
 */
let markerScanRing: Uint8Array = new Uint8Array(0);
function scanForEndMarker(bytes: Uint8Array): void {
	if (!state.active || state.endMarkerSeenAt !== null) return;
	// Concat the tail of the previous slice (length = marker - 1) with the new
	// slice so a marker straddling a frame boundary is still found.
	const tailLen = Math.min(markerScanRing.length, END_MARKER_BYTES.length - 1);
	const combined = new Uint8Array(tailLen + bytes.length);
	combined.set(markerScanRing.subarray(markerScanRing.length - tailLen), 0);
	combined.set(bytes, tailLen);
	if (indexOf(combined, END_MARKER_BYTES) !== -1) {
		state.endMarkerSeenAt = performance.now();
		// Defer report to next tick so the corresponding write/render is captured.
		requestAnimationFrame(() => requestAnimationFrame(report));
	}
	markerScanRing = bytes;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
	if (needle.length === 0 || haystack.length < needle.length) return -1;
	outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
}

function pct(arr: number[], p: number): number {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.min(
		sorted.length - 1,
		Math.floor((p / 100) * sorted.length),
	);
	return sorted[idx];
}

function report(): void {
	if (state.frames.length === 0 && state.writes.length === 0) {
		console.log("[bench] no samples collected");
		return;
	}
	const totalBytes = state.frames.reduce((s, f) => s + f.bytes, 0);
	const firstFrame = state.frames[0]?.recvT ?? state.startT;
	const lastFrame =
		state.frames[state.frames.length - 1]?.recvT ?? state.startT;
	const lastWriteEnd = state.writes[state.writes.length - 1]?.endT ?? lastFrame;
	const wallMs = (state.endMarkerSeenAt ?? lastWriteEnd) - firstFrame;
	const writeDurations = state.writes.map((w) => w.endT - w.startT);

	const summary = {
		frames: state.frames.length,
		totalBytes,
		bytesPerFrameAvg: state.frames.length
			? Math.round(totalBytes / state.frames.length)
			: 0,
		bytesPerFrameP50: pct(
			state.frames.map((f) => f.bytes),
			50,
		),
		bytesPerFrameP95: pct(
			state.frames.map((f) => f.bytes),
			95,
		),
		writes: state.writes.length,
		writeDurMsP50: pct(writeDurations, 50).toFixed(2),
		writeDurMsP95: pct(writeDurations, 95).toFixed(2),
		writeDurMsMax: writeDurations.length
			? Math.max(...writeDurations).toFixed(2)
			: "0",
		writeDurMsTotal: writeDurations.reduce((s, d) => s + d, 0).toFixed(2),
		wallMs: wallMs.toFixed(2),
		throughputKBps:
			wallMs > 0 ? (totalBytes / 1024 / (wallMs / 1000)).toFixed(1) : "n/a",
		endMarkerSeen: state.endMarkerSeenAt !== null,
	};
	console.log("[bench] report", summary);
	console.table([summary]);
}

export const bench = {
	isActive,
	start,
	stop,
	report,
	recordFrame,
	recordWriteStart,
	recordWriteEnd,
	scanForEndMarker,
};

// Auto-start if localStorage flag is set
if (
	typeof localStorage !== "undefined" &&
	localStorage.getItem(storageKey("bench")) === "1"
) {
	start();
}

// Expose on window for DevTools
if (typeof window !== "undefined") {
	(window as unknown as { __hrdle_bench: typeof bench }).__hrdle_bench = bench;
}
