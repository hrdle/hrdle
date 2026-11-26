import type { PaneViewport } from "../../../shared/types";
import { makePseudoViewport } from "./viewport-pseudo";

/** `isPseudo` marks a frame stitched here while the server's reply is in flight. */
export type ViewportListener = (
	viewport: PaneViewport,
	isPseudo?: boolean,
) => void;

const FRAMES_PER_PANE = 20;

/**
 * Between the server's viewport frames and the Terminals that paint them: what
 * each pane last showed, where it is scrolled to, and the frames it has
 * already been sent. Plain state rather than React so the layout keeps one per
 * connection and the scroll rules can be tested without a DOM. Asking the
 * server for a frame stays with the caller, which owns the connection.
 */
export class PaneViewportStore {
	private readonly listeners = new Map<string, Set<ViewportListener>>();
	/** Replayed to a Terminal that mounts after its pane's frame arrived. */
	private readonly latest = new Map<string, PaneViewport>();
	/** 0 = the live edge, N = N rows up into history. */
	private readonly offsets = new Map<string, number>();
	/** Frames by offset, oldest first, so scrolling back over one repaints at once. */
	private readonly frames = new Map<string, Map<number, PaneViewport>>();

	receive(paneId: string, viewport: PaneViewport): void {
		this.latest.set(paneId, viewport);
		let perPane = this.frames.get(paneId);
		if (!perPane) {
			perPane = new Map();
			this.frames.set(paneId, perPane);
		}
		perPane.delete(viewport.offset);
		perPane.set(viewport.offset, viewport);
		if (perPane.size > FRAMES_PER_PANE) {
			const oldest = perPane.keys().next().value;
			if (oldest !== undefined) perPane.delete(oldest);
		}
		// A reply for an offset the user has already scrolled past is kept for
		// later but not painted.
		const expected = this.offsets.get(paneId);
		if (expected !== undefined && expected !== viewport.offset) return;
		// The server clamps a requested offset to the history it has, so its
		// answer is the canonical position.
		this.offsets.set(paneId, viewport.offset);
		// No listener yet: `listen` replays it when the Terminal mounts.
		for (const listener of this.listeners.get(paneId) ?? []) {
			listener(viewport, false);
		}
	}

	/** Replays the pane's latest frame, if one has arrived, before returning. */
	listen(paneId: string, listener: ViewportListener): () => void {
		let set = this.listeners.get(paneId);
		if (!set) {
			set = new Set();
			this.listeners.set(paneId, set);
		}
		set.add(listener);
		const last = this.latest.get(paneId);
		if (last) listener(last);
		return () => {
			this.listeners.get(paneId)?.delete(listener);
		};
	}

	/** Every pane a Terminal has listened to, including ones since unmounted. */
	listenedPaneIds(): string[] {
		return [...this.listeners.keys()];
	}

	offset(paneId: string): number {
		return this.offsets.get(paneId) ?? 0;
	}

	historySize(paneId: string): number {
		return this.latest.get(paneId)?.historySize ?? 0;
	}

	/**
	 * Same sign as xterm's `scrollLines`: positive moves toward the live edge,
	 * negative into history. Returns the offset to ask the server for, or null
	 * when the pane is already at the end it was moved toward.
	 */
	scrollBy(paneId: string, lines: number): number | null {
		const current = this.offset(paneId);
		const next = Math.max(0, Math.min(this.historySize(paneId), current - lines));
		if (next === current) return null;
		this.moveTo(paneId, next);
		return next;
	}

	/** False when the pane is already at the live edge. */
	scrollToLive(paneId: string): boolean {
		if (this.offset(paneId) === 0) return false;
		this.moveTo(paneId, 0);
		return true;
	}

	/** Pane sizes changed, so the frames' line widths no longer match. */
	dropFrames(): void {
		this.frames.clear();
	}

	/**
	 * Another session is shown. Listeners stay: they belong to the Terminals,
	 * and one that survives the switch under the same pane id never listens
	 * again, so dropping it would leave that pane blank.
	 */
	forgetPositions(): void {
		this.latest.clear();
		this.offsets.clear();
	}

	clear(): void {
		this.forgetPositions();
		this.dropFrames();
	}

	/** Paints a frame already held for `offset`, or a stitched one, until the server answers. */
	private moveTo(paneId: string, offset: number): void {
		this.offsets.set(paneId, offset);
		const listeners = this.listeners.get(paneId);
		const last = this.latest.get(paneId);
		const held = this.frames.get(paneId)?.get(offset);
		if (held && held.historySize === this.historySize(paneId)) {
			if (listeners) for (const listener of listeners) listener(held, false);
		} else if (last && listeners) {
			const pseudo = makePseudoViewport(last, offset - last.offset);
			for (const listener of listeners) listener(pseudo, true);
		}
	}
}
