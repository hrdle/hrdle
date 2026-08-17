import { useCallback, useEffect, useRef, useState } from "react";
import { storageKey } from "../utils/app-storage";

/**
 * How big the text is on the screens where a conversation is read.
 *
 * This lived inside `ConversationViewer` — state, storage, the pinch handler
 * and the -/A/+ buttons — and covered exactly one screen. The steward's own
 * chat, which is where someone actually reads all day, had no size at all: its
 * bubbles were `text-sm` and stayed that way whatever anyone did in the viewer
 * behind them.
 *
 * So the machinery moves here and the screens share it. **The same key it
 * always used**, deliberately: a person who had already sized the viewer to
 * suit them keeps that size, and there is one answer to "how big is the chat"
 * rather than one per screen.
 */
const KEY = storageKey("conversation-font-size");

export const CHAT_FONT_DEFAULT = 15;
export const CHAT_FONT_MIN = 11;
export const CHAT_FONT_MAX = 24;

/** Two screens can be mounted at once - a dashboard control and the chat behind
 *  it - and a change in one has to reach the other. */
const CHANGED_EVENT = "hrdle-chat-font-size";

export function loadChatFontSize(): number {
	try {
		const saved = localStorage.getItem(KEY);
		if (saved) {
			const n = parseInt(saved, 10);
			if (!Number.isNaN(n) && n >= CHAT_FONT_MIN && n <= CHAT_FONT_MAX) return n;
		}
	} catch {
		// ignore
	}
	return CHAT_FONT_DEFAULT;
}

function save(n: number): void {
	try {
		localStorage.setItem(KEY, String(n));
	} catch {
		// ignore
	}
	window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: n }));
}

function clamp(n: number): number {
	return Math.max(CHAT_FONT_MIN, Math.min(CHAT_FONT_MAX, n));
}

export interface ChatFontSize {
	fontSize: number;
	/** Step and persist. */
	changeFontSize: (delta: number) => void;
	/** Back to the default, persisted. */
	resetFontSize: () => void;
	/** Set without persisting - mid-pinch, where every frame would be a write. */
	previewFontSize: (size: number) => void;
	/** Persist whatever is currently set. */
	commitFontSize: () => void;
}

export function useChatFontSize(): ChatFontSize {
	const [fontSize, setFontSize] = useState<number>(loadChatFontSize);

	// Another screen changed it. `detail` rather than re-reading storage: the
	// event fires in this tab, where `storage` does not.
	useEffect(() => {
		const onChanged = (e: Event) => {
			const next = (e as CustomEvent<number>).detail;
			if (typeof next === "number") setFontSize(next);
		};
		window.addEventListener(CHANGED_EVENT, onChanged);
		return () => window.removeEventListener(CHANGED_EVENT, onChanged);
	}, []);

	const changeFontSize = useCallback((delta: number) => {
		setFontSize((prev) => {
			const next = clamp(prev + delta);
			if (next !== prev) save(next);
			return next;
		});
	}, []);

	const resetFontSize = useCallback(() => {
		setFontSize(CHAT_FONT_DEFAULT);
		save(CHAT_FONT_DEFAULT);
	}, []);

	const previewFontSize = useCallback((size: number) => {
		setFontSize((prev) => (prev === clamp(size) ? prev : clamp(size)));
	}, []);

	const commitFontSize = useCallback(() => {
		setFontSize((prev) => {
			save(prev);
			return prev;
		});
	}, []);

	return {
		fontSize,
		changeFontSize,
		resetFontSize,
		previewFontSize,
		commitFontSize,
	};
}

/**
 * What a conversation surface has to set for its text to follow the size.
 *
 * Two values, not one. The body scales with `fontSize`; everything secondary -
 * a tool call, a file path, a timestamp - reads through `--cv-fs-meta`, which
 * trails it rather than tracking it proportionally. At 24px a proportional
 * caption is as loud as the message; three points below the body it stays a
 * caption at every size, which is what "secondary" has to keep meaning.
 */
export function chatFontStyle(fontSize: number): React.CSSProperties {
	return {
		fontSize: `${fontSize}px`,
		["--cv-fs-meta" as never]: `${Math.max(10, fontSize - 3)}px`,
	};
}

/**
 * Pinch to resize, on a scrolling element.
 *
 * The gesture the conversation viewer already had, now available to any of
 * these screens - and the only control that is genuinely to hand on a phone,
 * where the alternative is leaving the conversation for a settings panel.
 *
 * Persisted at the end of the gesture rather than on every frame: a pinch is
 * thirty size changes and one decision.
 */
export function usePinchFontSize(
	ref: React.RefObject<HTMLElement | null>,
	{ fontSize, previewFontSize, commitFontSize }: ChatFontSize,
): void {
	// Read inside the handlers rather than captured, so the listeners are bound
	// once instead of re-bound on every size change mid-pinch.
	const sizeRef = useRef(fontSize);
	sizeRef.current = fontSize;

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let pinch: { d: number; size: number } | null = null;

		const distance = (touches: TouchList): number => {
			const [a, b] = [touches[0], touches[1]];
			if (!a || !b) return 0;
			return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
		};

		const onStart = (e: TouchEvent) => {
			if (e.touches.length !== 2) return;
			e.preventDefault();
			pinch = { d: distance(e.touches), size: sizeRef.current };
		};
		const onMove = (e: TouchEvent) => {
			if (e.touches.length !== 2 || !pinch || pinch.d === 0) return;
			e.preventDefault();
			previewFontSize(Math.round(pinch.size * (distance(e.touches) / pinch.d)));
		};
		const onEnd = (e: TouchEvent) => {
			if (e.touches.length >= 2 || !pinch) return;
			pinch = null;
			commitFontSize();
		};

		el.addEventListener("touchstart", onStart, { passive: false });
		el.addEventListener("touchmove", onMove, { passive: false });
		el.addEventListener("touchend", onEnd);
		el.addEventListener("touchcancel", onEnd);
		return () => {
			el.removeEventListener("touchstart", onStart);
			el.removeEventListener("touchmove", onMove);
			el.removeEventListener("touchend", onEnd);
			el.removeEventListener("touchcancel", onEnd);
		};
	}, [ref, previewFontSize, commitFontSize]);
}
