/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div row UI shared with V1; keyboard navigation provided via main shortcuts */
import { useTranslation } from "react-i18next";
import type { HistorySession } from "../../../../shared/types";
import { agentBadge } from "../../utils/agentDisplay";
import { formatRelativeTime } from "../../utils/format";

interface HistoryRowV2Props {
	session: HistorySession;
	isActive: boolean;
	isResuming: boolean;
	onTap: () => void;
	onResume: () => void;
	onNavigate: () => void;
}

/**
 * One row of the history list.
 *
 * What a person is looking for here is *which conversation this was*, so the
 * text leads and everything else is one quiet line under it. The recap - a
 * summary of what actually happened - beats the prompt when there is one, and
 * reads brighter for it; the prompt is only the fallback.
 */
export function HistoryRowV2({
	session,
	isActive,
	isResuming,
	onTap,
	onResume,
	onNavigate,
}: HistoryRowV2Props) {
	const { t, i18n } = useTranslation();

	const prompt =
		session.lastPrompt ||
		session.firstPrompt ||
		session.summary ||
		t("history.noTitle");
	const badge = agentBadge(session.agent);

	const showPeer =
		session.peerId && session.peerId !== "local" && session.peerNickname;

	// project · agent · branch · when. One line, in the order you would narrow
	// them down in: where, who, which branch, how long ago.
	const meta: React.ReactNode[] = [
		<span key="project" className="truncate">
			{session.projectName}
		</span>,
		<span key="agent" className="inline-flex shrink-0 items-center gap-1">
			<span className={`h-1.5 w-1.5 rounded-full ${badge.barClassName}`} />
			{badge.label}
		</span>,
	];
	if (session.gitBranch) {
		meta.push(
			<span key="branch" className="max-w-[140px] truncate">
				{session.gitBranch}
			</span>,
		);
	}
	meta.push(
		<span key="time" className="shrink-0">
			{/* `modified` — the same key the list is sorted and bucketed by. Using
			    recapAt made the times look out of order, since a recap can be days
			    older than the last activity. */}
			{formatRelativeTime(session.modified, t, i18n.language)}
		</span>,
	);

	return (
		<div
			onClick={onTap}
			className="group cursor-pointer border-b border-cv-border/60 px-4 py-3 transition-colors hover:bg-cv-surface"
			style={
				showPeer && session.peerColor
					? { borderLeft: `2px solid ${session.peerColor}`, paddingLeft: 14 }
					: undefined
			}
		>
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					{session.recap ? (
						<p className="line-clamp-2 text-[14px] leading-snug text-cv-text">
							{session.recap}
						</p>
					) : (
						<p className="line-clamp-2 text-[14px] leading-snug text-cv-text-secondary">
							{prompt}
						</p>
					)}

					<div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-cv-text-muted">
						{meta.map((node, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: separators between fixed, ordered parts
							<span key={`sep-${i}`} className="contents">
								{i > 0 && <span className="shrink-0 opacity-50">·</span>}
								{node}
							</span>
						))}
						{showPeer && (
							<>
								<span className="shrink-0 opacity-50">·</span>
								<span
									className="inline-flex shrink-0 items-center gap-1"
									style={{ color: session.peerColor }}
								>
									<span
										className="h-1.5 w-1.5 rounded-full"
										style={{ backgroundColor: session.peerColor }}
									/>
									{session.peerNickname}
								</span>
							</>
						)}
					</div>
				</div>

				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						if (isActive) onNavigate();
						else onResume();
					}}
					disabled={isResuming}
					className="shrink-0 rounded-lg px-2.5 py-1 text-[11.5px] font-medium text-cv-text-muted transition-colors hover:bg-cv-surface-hover hover:text-cv-text disabled:opacity-50"
				>
					{isActive
						? t("session.navigate")
						: isResuming
							? "…"
							: t("session.resume")}
				</button>
			</div>
		</div>
	);
}
