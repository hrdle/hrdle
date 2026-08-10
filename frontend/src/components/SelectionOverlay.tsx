/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import type { Terminal } from "@xterm/xterm";
import { memo } from "react";
import type { SelectionRange } from "../hooks/useSelectionMode";

interface SelectionOverlayProps {
	terminalRef: React.RefObject<Terminal | null>;
	containerRef: React.RefObject<HTMLDivElement | null>;
	selectionRange: SelectionRange | null;
	copyFeedback: string | null;
	onHandleTouchDragStart: (e: React.TouchEvent, edge: "start" | "end") => void;
	onHandleMouseDragStart: (e: React.MouseEvent, edge: "start" | "end") => void;
	onCopy: () => void;
	onCancel: () => void;
}

export const SelectionOverlay = memo(function SelectionOverlay({
	terminalRef,
	containerRef,
	selectionRange,
	copyFeedback,
	onHandleTouchDragStart,
	onHandleMouseDragStart,
	onCopy,
	onCancel,
}: SelectionOverlayProps) {
	const term = terminalRef.current;
	// biome-ignore lint/suspicious/noExplicitAny: xterm.js exposes layout metrics via undocumented _core API
	const core = (term as any)?._core;
	const cellW = core?._renderService?.dimensions?.css?.cell?.width;
	const cellH = core?._renderService?.dimensions?.css?.cell?.height;

	// Get offset from .xterm-screen inside container
	const screenEl = containerRef.current?.querySelector(".xterm-screen");
	const containerEl = containerRef.current;
	let offsetX = 0;
	let offsetY = 0;
	if (screenEl && containerEl) {
		const sr = screenEl.getBoundingClientRect();
		const cr = containerEl.getBoundingClientRect();
		offsetX = sr.left - cr.left;
		offsetY = sr.top - cr.top;
	}

	return (
		<>
			{/* Selection highlight overlay + handles */}
			{selectionRange &&
				cellW &&
				cellH &&
				term &&
				(() => {
					const { startCol, startRow, endCol, endRow } = selectionRange;
					const rects: { x: number; y: number; w: number; h: number }[] = [];

					if (startRow === endRow) {
						rects.push({
							x: startCol * cellW,
							y: startRow * cellH,
							w: (endCol - startCol + 1) * cellW,
							h: cellH,
						});
					} else {
						rects.push({
							x: startCol * cellW,
							y: startRow * cellH,
							w: (term.cols - startCol) * cellW,
							h: cellH,
						});
						for (let r = startRow + 1; r < endRow; r++) {
							rects.push({
								x: 0,
								y: r * cellH,
								w: term.cols * cellW,
								h: cellH,
							});
						}
						rects.push({
							x: 0,
							y: endRow * cellH,
							w: (endCol + 1) * cellW,
							h: cellH,
						});
					}

					const startX = startCol * cellW + offsetX;
					const startY = startRow * cellH + offsetY;
					const endX = (endCol + 1) * cellW + offsetX;
					const endY = (endRow + 1) * cellH + offsetY;

					return (
						<>
							{rects.map((r, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: rects regenerated each render; index is stable per-frame
									key={i}
									className="absolute pointer-events-none"
									style={{
										left: r.x + offsetX,
										top: r.y + offsetY,
										width: r.w,
										height: r.h,
										backgroundColor: "rgba(59, 130, 246, 0.35)",
									}}
								/>
							))}
							{/* Start handle */}
							<div
								data-selection-control
								className="absolute z-50 touch-none flex items-center justify-center select-none"
								style={{
									left: startX - 16,
									top: startY - 32,
									width: 32,
									height: 32,
									borderRadius: "50%",
									backgroundColor: "rgba(59,130,246,0.9)",
									border: "2px solid white",
									boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
									WebkitTouchCallout: "none",
									WebkitUserSelect: "none",
								}}
								onTouchStart={(e) => {
									e.stopPropagation();
									// No preventDefault: React registers `touchstart` passively,
									// so it is ignored. `touch-none` above is what stops the drag
									// from scrolling the page.
									onHandleTouchDragStart(e, "start");
								}}
								onMouseDown={(e) => {
									e.stopPropagation();
									onHandleMouseDragStart(e, "start");
								}}
								onContextMenu={(e) => e.preventDefault()}
							>
								<span className="text-white text-xs font-bold">S</span>
							</div>
							{/* End handle */}
							<div
								data-selection-control
								className="absolute z-50 touch-none flex items-center justify-center select-none"
								style={{
									left: endX - 16,
									top: endY + 4,
									width: 32,
									height: 32,
									borderRadius: "50%",
									backgroundColor: "rgba(59,130,246,0.9)",
									border: "2px solid white",
									boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
									WebkitTouchCallout: "none",
									WebkitUserSelect: "none",
								}}
								onTouchStart={(e) => {
									e.stopPropagation();
									// See the start handle above: passive, so this would be ignored.
									onHandleTouchDragStart(e, "end");
								}}
								onMouseDown={(e) => {
									e.stopPropagation();
									onHandleMouseDragStart(e, "end");
								}}
								onContextMenu={(e) => e.preventDefault()}
							>
								<span className="text-white text-xs font-bold">E</span>
							</div>
						</>
					);
				})()}

			{/* Selection Mode badge + preview */}
			{(() => {
				const selCellH = cellH || 18;
				let selOffsetY = 0;
				if (screenEl && containerEl) {
					const sr = screenEl.getBoundingClientRect();
					const cr = containerEl.getBoundingClientRect();
					selOffsetY = sr.top - cr.top;
				}
				const selTopPx = selectionRange
					? selectionRange.startRow * selCellH + selOffsetY
					: 0;
				const selBottomPx = selectionRange
					? (selectionRange.endRow + 1) * selCellH + selOffsetY
					: 0;
				const uiHeight = 120;
				const overlapsTop = selTopPx < uiHeight;
				const panelTop = overlapsTop
					? Math.max(selBottomPx + 40, uiHeight)
					: 36;
				const badgeTop = overlapsTop ? panelTop - 28 : 8;

				const sel = term?.getSelection();
				return (
					<>
						<div
							className="absolute left-2 z-40 bg-blue-600/80 px-2 py-1 rounded text-xs text-white pointer-events-none"
							style={{ top: badgeTop }}
						>
							Selection Mode
						</div>
						{sel && (
							<div
								data-selection-control
								className="absolute left-2 right-2 z-40 bg-black/90 border border-blue-500/50 rounded-lg px-3 py-2 shadow-xl max-h-[40vh] overflow-auto select-none"
								style={{ top: panelTop, WebkitTouchCallout: "none" }}
								onMouseDown={(e) => e.stopPropagation()}
								onContextMenu={(e) => e.preventDefault()}
							>
								<pre className="text-blue-200 font-mono text-xs whitespace-pre-wrap break-all mb-2">
									{sel}
								</pre>
								<div className="flex gap-2">
									<button
										type="button"
										data-selection-control
										className="px-4 py-1.5 bg-blue-600 active:bg-blue-700 text-white rounded text-sm font-medium"
										onTouchEnd={(e) => {
											e.preventDefault();
											e.stopPropagation();
											onCopy();
										}}
										onClick={onCopy}
									>
										Copy
									</button>
									<button
										type="button"
										data-selection-control
										className="px-4 py-1.5 bg-gray-600 active:bg-gray-700 text-white rounded text-sm font-medium"
										onTouchEnd={(e) => {
											e.preventDefault();
											e.stopPropagation();
											onCancel();
										}}
										onClick={onCancel}
									>
										Cancel
									</button>
								</div>
							</div>
						)}
					</>
				);
			})()}

			{/* Copy feedback toast */}
			{copyFeedback && (
				<div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-blue-600 px-3 py-1.5 rounded-lg text-sm text-white font-medium shadow-lg pointer-events-none">
					{copyFeedback}
				</div>
			)}
		</>
	);
});
