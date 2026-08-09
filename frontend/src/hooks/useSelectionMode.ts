import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../utils/clipboard";

export interface SelectionRange {
	startCol: number;
	startRow: number;
	endCol: number;
	endRow: number;
}

export interface SelectionStart {
	col: number;
	row: number;
	viewportRow: number;
}

interface UseSelectionModeOptions {
	terminalRef: React.RefObject<Terminal | null>;
	containerRef: React.RefObject<HTMLDivElement | null>;
}

export function useSelectionMode({
	terminalRef,
	containerRef,
}: UseSelectionModeOptions) {
	const [selectionMode, setSelectionMode] = useState(false);
	const [copyButtonPos, setCopyButtonPos] = useState<{
		x: number;
		y: number;
	} | null>(null);
	const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(
		null,
	);
	const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
	const selectionStartRef = useRef<SelectionStart | null>(null);
	const selectionModeRef = useRef(false);
	const draggingHandleRef = useRef<"start" | "end" | null>(null);

	// Sync ref with state and block xterm.js mouse handling during selection
	useEffect(() => {
		selectionModeRef.current = selectionMode;
		const screen = containerRef.current?.querySelector(
			".xterm-screen",
		) as HTMLElement | null;
		if (screen) {
			screen.style.pointerEvents = selectionMode ? "none" : "";
		}
	}, [selectionMode, containerRef]);

	const exitSelectionMode = useCallback(() => {
		setSelectionMode(false);
		selectionModeRef.current = false;
		setCopyButtonPos(null);
		setSelectionRange(null);
		selectionStartRef.current = null;
		terminalRef.current?.clearSelection();
	}, [terminalRef]);

	const exitSelectionModeRef = useRef(exitSelectionMode);
	exitSelectionModeRef.current = exitSelectionMode;

	const flashFeedback = useCallback((message: string) => {
		setCopyFeedback(message);
		setTimeout(() => setCopyFeedback(null), 1500);
	}, []);

	const handleCopySelection = useCallback(() => {
		const sel = terminalRef.current?.getSelection();
		if (!sel) {
			flashFeedback("No selection");
			exitSelectionMode();
			return;
		}
		const text = sel;
		exitSelectionMode();
		void copyText(text).then((ok) => flashFeedback(ok ? "Copied!" : "Failed"));
	}, [exitSelectionMode, terminalRef, flashFeedback]);

	// Touch handle drag
	const handleHandleDragStart = useCallback(
		(e: React.TouchEvent, edge: "start" | "end") => {
			e.preventDefault();
			draggingHandleRef.current = edge;

			const handleMove = (ev: TouchEvent) => {
				ev.preventDefault();
				const term = terminalRef.current;
				const container = containerRef.current;
				if (!term || !container) return;

				// biome-ignore lint/suspicious/noExplicitAny: xterm.js exposes cell dimensions via undocumented _core API
				const core = (term as any)._core;
				const cellW = core?._renderService?.dimensions?.css?.cell?.width;
				const cellH = core?._renderService?.dimensions?.css?.cell?.height;
				if (!cellW || !cellH) return;

				const screenEl = container.querySelector(".xterm-screen");
				if (!screenEl) return;
				const rect = screenEl.getBoundingClientRect();
				const touch = ev.touches[0];
				const fingerOffsetY = 30;
				const col = Math.max(
					0,
					Math.min(
						term.cols - 1,
						Math.floor((touch.clientX - rect.left) / cellW),
					),
				);
				const vRow = Math.max(
					0,
					Math.min(
						term.rows - 1,
						Math.floor((touch.clientY - fingerOffsetY - rect.top) / cellH),
					),
				);
				const viewportY = term.buffer.active.viewportY;

				setSelectionRange((prev) => {
					if (!prev) return null;
					let newRange: typeof prev;
					if (draggingHandleRef.current === "start") {
						const endOffset = prev.endRow * term.cols + prev.endCol;
						const newOffset = vRow * term.cols + col;
						if (newOffset > endOffset) return prev;
						newRange = { ...prev, startCol: col, startRow: vRow };
						selectionStartRef.current = {
							col,
							row: viewportY + vRow,
							viewportRow: vRow,
						};
					} else {
						const startOffset = prev.startRow * term.cols + prev.startCol;
						const newOffset = vRow * term.cols + col;
						if (newOffset < startOffset) return prev;
						newRange = { ...prev, endCol: col, endRow: vRow };
					}
					const sOffset = newRange.startRow * term.cols + newRange.startCol;
					const eOffset = newRange.endRow * term.cols + newRange.endCol;
					term.select(
						newRange.startCol,
						viewportY + newRange.startRow,
						eOffset - sOffset + 1,
					);
					return newRange;
				});
			};

			const handleEnd = () => {
				draggingHandleRef.current = null;
				document.removeEventListener("touchmove", handleMove);
				document.removeEventListener("touchend", handleEnd);
			};

			document.addEventListener("touchmove", handleMove, { passive: false });
			document.addEventListener("touchend", handleEnd);
		},
		[terminalRef, containerRef],
	);

	// Mouse handle drag
	const handleHandleMouseDragStart = useCallback(
		(e: React.MouseEvent, edge: "start" | "end") => {
			e.preventDefault();
			e.stopPropagation();
			draggingHandleRef.current = edge;

			const handleMove = (ev: MouseEvent) => {
				ev.preventDefault();
				const term = terminalRef.current;
				const container = containerRef.current;
				if (!term || !container) return;

				// biome-ignore lint/suspicious/noExplicitAny: xterm.js exposes cell dimensions via undocumented _core API
				const core = (term as any)._core;
				const cellW = core?._renderService?.dimensions?.css?.cell?.width;
				const cellH = core?._renderService?.dimensions?.css?.cell?.height;
				if (!cellW || !cellH) return;

				const screenEl = container.querySelector(".xterm-screen");
				if (!screenEl) return;
				const rect = screenEl.getBoundingClientRect();
				const col = Math.max(
					0,
					Math.min(term.cols - 1, Math.floor((ev.clientX - rect.left) / cellW)),
				);
				const vRow = Math.max(
					0,
					Math.min(term.rows - 1, Math.floor((ev.clientY - rect.top) / cellH)),
				);
				const viewportY = term.buffer.active.viewportY;

				setSelectionRange((prev) => {
					if (!prev) return null;
					let newRange: typeof prev;
					if (draggingHandleRef.current === "start") {
						const endOffset = prev.endRow * term.cols + prev.endCol;
						const newOffset = vRow * term.cols + col;
						if (newOffset > endOffset) return prev;
						newRange = { ...prev, startCol: col, startRow: vRow };
						selectionStartRef.current = {
							col,
							row: viewportY + vRow,
							viewportRow: vRow,
						};
					} else {
						const startOffset = prev.startRow * term.cols + prev.startCol;
						const newOffset = vRow * term.cols + col;
						if (newOffset < startOffset) return prev;
						newRange = { ...prev, endCol: col, endRow: vRow };
					}
					const sOffset = newRange.startRow * term.cols + newRange.startCol;
					const eOffset = newRange.endRow * term.cols + newRange.endCol;
					term.select(
						newRange.startCol,
						viewportY + newRange.startRow,
						eOffset - sOffset + 1,
					);
					return newRange;
				});
			};

			const handleEnd = () => {
				draggingHandleRef.current = null;
				document.removeEventListener("mousemove", handleMove, true);
				document.removeEventListener("mouseup", handleEnd, true);
			};

			document.addEventListener("mousemove", handleMove, true);
			document.addEventListener("mouseup", handleEnd, true);
		},
		[terminalRef, containerRef],
	);

	return {
		selectionMode,
		setSelectionMode,
		selectionModeRef,
		selectionRange,
		setSelectionRange,
		selectionStartRef,
		copyButtonPos,
		setCopyButtonPos,
		copyFeedback,
		exitSelectionMode,
		exitSelectionModeRef,
		handleCopySelection,
		handleHandleDragStart,
		handleHandleMouseDragStart,
	};
}
