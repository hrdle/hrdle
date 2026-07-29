#!/usr/bin/env bun
// @ts-nocheck — standalone bun script, lives outside the project tsconfig.
//
// End-to-end CPU profile capture against the running hrdle.service.
//
// Subcommands:
//   profile [--seconds N] [--out PATH]   Enable inspector → capture → disable.
//   analyze <profile.json>               Top-N hot functions (self + total).
//   drill <profile.json> <name>          Leaf frames under any sample touching <name>.
//
// Talks directly to Bun's WebKit Inspector over CDP, so no Chrome / DevTools
// session is needed — the profile JSON ends up on disk ready for `analyze`.

import { spawnSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";

const [, , cmd, ...rest] = process.argv;

if (cmd === "profile") {
	await cmdProfile(parseProfileArgs(rest));
} else if (cmd === "analyze") {
	await cmdAnalyze(rest[0]);
} else if (cmd === "drill") {
	await cmdDrill(rest[0], rest[1]);
} else {
	usage();
	process.exit(1);
}

function usage(): void {
	console.error("usage:");
	console.error("  profile.ts profile [--seconds N] [--out PATH]");
	console.error("  profile.ts analyze <profile.json>");
	console.error("  profile.ts drill   <profile.json> <function-name-substring>");
}

function parseProfileArgs(args: string[]): { seconds: number; out: string } {
	let seconds = 30;
	let out = "/tmp/hrdle.profile.json";
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--seconds") seconds = Number(args[++i]);
		else if (args[i] === "--out") out = args[++i];
	}
	if (!Number.isFinite(seconds) || seconds < 1) {
		console.error("--seconds must be a positive integer");
		process.exit(1);
	}
	return { seconds, out };
}

async function cmdProfile({ seconds, out }: { seconds: number; out: string }) {
	const enable = spawnSync("hrdle", ["debug", "enable"], { stdio: "inherit" });
	if (enable.status !== 0) {
		console.error("hrdle debug enable failed");
		process.exit(1);
	}

	try {
		// Service just restarted — give Bun time to bind the inspector port and
		// re-attach its routes before we open the WS. The first 2-3s of a fresh
		// process are mostly init and don't produce useful samples anyway.
		await waitForInspector();
		const wsUrl = await findWsUrl();
		console.error(`[cdp] using ${wsUrl}`);
		const profile = await captureProfile(wsUrl, seconds);
		await writeFile(out, JSON.stringify(profile));
		console.error(`[cdp] saved ${out}`);
		console.error("\nrun `bun .../profile.ts analyze " + out + "` to see hot functions.");
	} finally {
		spawnSync("hrdle", ["debug", "disable"], { stdio: "inherit" });
	}
}

async function waitForInspector(): Promise<void> {
	for (let i = 0; i < 30; i++) {
		try {
			const r = await fetch("http://localhost:9229/json/version", { signal: AbortSignal.timeout(500) });
			if (r.ok) {
				// Inspector is up. Sleep one more beat so startup work settles.
				await new Promise((r) => setTimeout(r, 800));
				return;
			}
		} catch {
			// not ready yet
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error("inspector did not come up within 6s");
}

async function findWsUrl(): Promise<string> {
	for (let i = 0; i < 10; i++) {
		const journal = spawnSync(
			"journalctl",
			[
				"--user",
				"-u",
				"hrdle.service",
				"--since",
				"1 minute ago",
				"--no-pager",
				"--output=cat",
			],
			{ encoding: "utf8" },
		);
		const m = journal.stdout?.match(/(ws:\/\/[^\s]+)/g);
		if (m && m.length > 0) {
			// Last match = most recent restart.
			return m[m.length - 1];
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("could not find Bun inspector WS URL in journal");
}

async function captureProfile(wsUrl: string, seconds: number): Promise<unknown> {
	const ws = new WebSocket(wsUrl);
	let nextId = 1;
	const pending = new Map<number, (v: unknown) => void>();
	let trackingCompleteResolve: ((v: unknown) => void) | null = null;
	const trackingComplete = new Promise<unknown>((r) => {
		trackingCompleteResolve = r;
	});

	ws.addEventListener("message", (ev: MessageEvent) => {
		const data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
		if (typeof data.id === "number" && pending.has(data.id)) {
			const r = pending.get(data.id);
			pending.delete(data.id);
			if (data.error) throw new Error(`cdp: ${data.error.message}`);
			r?.(data.result);
		} else if (data.method === "ScriptProfiler.trackingComplete") {
			trackingCompleteResolve?.(data.params);
		}
	});

	const call = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<any>((resolve) => {
			const id = nextId++;
			pending.set(id, resolve);
			ws.send(JSON.stringify({ id, method, params }));
		});

	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
	});

	// Don't call Inspector/Debugger.enable here — they put JSC into a
	// debugger-attached state that suppresses the sampling tracker. Just start
	// the profiler directly; Bun's default sampling rate kicks in.
	await call("ScriptProfiler.startTracking", { includeSamples: true });
	console.error(`[cdp] tracking for ${seconds}s…`);
	await new Promise((r) => setTimeout(r, seconds * 1000));
	const stopResult = await call("ScriptProfiler.stopTracking");

	// Some Bun versions return samples inline; others fire trackingComplete.
	// Try both.
	const eventParams: any = await Promise.race([
		trackingComplete,
		new Promise<null>((r) => setTimeout(() => r(null), 5000)),
	]);
	ws.close();

	const samples = eventParams?.samples ?? stopResult?.samples ?? null;
	if (!samples || (samples.stackTraces && samples.stackTraces.length === 0)) {
		const stopKeys = stopResult ? Object.keys(stopResult).join(",") : "(no stopResult)";
		const evKeys = eventParams ? Object.keys(eventParams).join(",") : "(no event)";
		throw new Error(
			`no usable samples — stopTracking returned [${stopKeys}], trackingComplete params [${evKeys}]`,
		);
	}
	return samples;
}

// --------------------------------------------------------------------------
// analyze / drill: read the captured profile and surface hot functions.

interface Frame {
	name: string;
	url: string;
	line: number;
}
interface Trace {
	stackFrames: Frame[];
}

function frameKey(f: Frame): string {
	const name = f.name || "(anon)";
	const u = f.url || "?";
	const short = u.startsWith("/$bunfs/") ? "[bundle]" : u.startsWith("internal:") ? u : "?";
	return `${name} @ ${short}:${f.line}`;
}

async function cmdAnalyze(path: string) {
	if (!path) {
		usage();
		process.exit(1);
	}
	const raw = await readFile(path, "utf8");
	const traces: Trace[] = JSON.parse(raw).stackTraces ?? [];
	console.log(`# samples: ${traces.length}`);

	const self = new Map<string, number>();
	const total = new Map<string, number>();
	for (const t of traces) {
		const f = t.stackFrames ?? [];
		if (f.length === 0) continue;
		const leaf = frameKey(f[0]);
		self.set(leaf, (self.get(leaf) ?? 0) + 1);
		const seen = new Set<string>();
		for (const frame of f) {
			const k = frameKey(frame);
			if (seen.has(k)) continue;
			seen.add(k);
			total.set(k, (total.get(k) ?? 0) + 1);
		}
	}

	printTop("Top 15 by self time (where CPU is actually spent)", self, traces.length, 15);
	printTop(
		"Top 15 by total (function appears anywhere in call stack)",
		total,
		traces.length,
		15,
	);
}

async function cmdDrill(path: string, target: string) {
	if (!path || !target) {
		usage();
		process.exit(1);
	}
	const raw = await readFile(path, "utf8");
	const traces: Trace[] = JSON.parse(raw).stackTraces ?? [];
	const hits = traces.filter((t) => t.stackFrames.some((f) => f.name?.includes(target)));
	console.log(`samples containing ${target}: ${hits.length} / ${traces.length}`);
	const leaf = new Map<string, number>();
	for (const t of hits) {
		const k = frameKey(t.stackFrames[0]);
		leaf.set(k, (leaf.get(k) ?? 0) + 1);
	}
	printTop(`Top 20 leaf frames under ${target}`, leaf, hits.length, 20);
}

function printTop(title: string, map: Map<string, number>, denom: number, n: number) {
	const top = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
	console.log(`\n## ${title}`);
	for (const [k, v] of top) {
		const pct = ((v / denom) * 100).toFixed(1);
		console.log(`  ${pct.padStart(5)}% (${String(v).padStart(4)})  ${k}`);
	}
}
