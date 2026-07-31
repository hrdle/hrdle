import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { HistorySession } from "../../../../shared/types";
import type { HistoryListRow } from "../../utils/historyBuckets";
import { HistoryRowV2 } from "./HistoryRowV2";

interface VirtualizedHistoryListProps {
	rows: HistoryListRow[];
	activeCcSessionIds: Set<string>;
	resumingId: string | null;
	onTap: (session: HistorySession, projectDirName?: string) => void;
	onResume: (session: HistorySession) => void;
	onNavigate: (session: HistorySession) => void;
}

/**
 * Virtualized history list with inline date-bucket headers. Uses an internal
 * scroll container as the scrollElement (same pattern as ConversationViewer).
 * measureElement is NOT corrected for the SessionList contentScale transform:
 * ResizeObserver reports the pre-transform layout size, so the virtualizer's
 * math stays correct under pinch-zoom.
 */
export function VirtualizedHistoryList({
	rows,
	activeCcSessionIds,
	resumingId,
	onTap,
	onResume,
	onNavigate,
}: VirtualizedHistoryListProps) {
	const parentRef = useRef<HTMLDivElement>(null);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		// header ~30px; plain prompt row ~66px; 3-line recap row ~108px.
		// measureElement corrects these; estimates just minimize first-paint jump.
		estimateSize: (index) => {
			const row = rows[index];
			if (!row) return 66;
			if (row.kind === "header") return 30;
			return row.session.recap ? 108 : 66;
		},
		overscan: 12,
		getItemKey: (index) => rows[index]?.key ?? index,
	});

	return (
		<div
			ref={parentRef}
			className="h-full overflow-y-auto overscroll-contain bg-cv-bg"
		>
			<div
				style={{
					height: `${virtualizer.getTotalSize()}px`,
					width: "100%",
					position: "relative",
				}}
			>
				<div
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: "100%",
						transform: `translateY(${virtualizer.getVirtualItems()[0]?.start ?? 0}px)`,
					}}
				>
					{virtualizer.getVirtualItems().map((virtualRow) => {
						const row = rows[virtualRow.index];
						if (!row) return null;
						return (
							<div
								key={virtualRow.key}
								data-index={virtualRow.index}
								ref={virtualizer.measureElement}
							>
								{row.kind === "header" ? (
									<div className="flex items-center justify-between px-4 pb-1.5 pt-4 text-[11px] font-medium text-cv-text-muted">
										<span>{row.label}</span>
										<span className="tabular-nums opacity-70">{row.count}</span>
									</div>
								) : (
									<HistoryRowV2
										session={row.session}
										isActive={activeCcSessionIds.has(row.session.sessionId)}
										isResuming={resumingId === row.session.sessionId}
										onTap={() => onTap(row.session, row.dirName)}
										onResume={() => onResume(row.session)}
										onNavigate={() => onNavigate(row.session)}
									/>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
