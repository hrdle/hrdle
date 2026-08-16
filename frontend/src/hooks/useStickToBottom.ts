import { type RefObject, useCallback, useEffect, useRef } from "react";

/** How far from the bottom still counts as "reading the newest". */
const NEAR_BOTTOM_PX = 80;

/**
 * Keeps a scroller pinned to its newest content, and stops as soon as the
 * reader scrolls away.
 *
 * Scrolling on a length change was not enough: a turn can be rewritten in
 * place, and a picture finishes loading after the scroll and pushes the last
 * message under the fold - measured at 178px short on a real session.
 *
 * Returns the pin, for anything that changes height on its own clock.
 */
export function useStickToBottom(
	ref: RefObject<HTMLElement | null>,
	deps: unknown[],
): () => void {
	const stuck = useRef(true);

	const pin = useCallback(() => {
		const el = ref.current;
		if (!el || !stuck.current) return;
		el.scrollTop = el.scrollHeight;
	}, [ref]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onScroll = () => {
			stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [ref]);

	// After paint, or the height being measured is the one before this change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the cue; none is read here.
	useEffect(() => {
		const frame = requestAnimationFrame(pin);
		return () => cancelAnimationFrame(frame);
	}, deps);

	return pin;
}
