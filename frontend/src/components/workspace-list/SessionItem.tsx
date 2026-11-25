/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowRight, ExternalLink, GripVertical, Play, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AGENT_PROVIDERS, agentSupportsConversationMetadata, type ExtendedSessionResponse, type IndicatorState, isAgentProvider, type SessionTheme } from "../../../../shared/types";
import { openClaudeAppSession } from "../../utils/claude-app";
import { formatModelName, formatRelativeTime } from "../../utils/format";
import { toHomeShortPath } from "../../utils/path";
import { storageKey } from "../../utils/app-storage";
import {
	CollapsedWorkspaceSummary,
	ContextMeter,
	MemoryLabel,
	PaneRow,
	pickLeadPane,
	TabRow,
} from "./PaneRows";

// Accent color hex values for redesigned card left bar
const ACCENT_HEX: Record<SessionTheme, string> = {
	red: "#ef4444",
	orange: "#f97316",
	amber: "#f59e0b",
	green: "#22c55e",
	teal: "#14b8a6",
	blue: "#3b82f6",
	indigo: "#6366f1",
	purple: "#a855f7",
	pink: "#ec4899",
};

export const AGENT_FAILURE_KEYS = new Set(["exited", "timeout", "kind_mismatch", "name_lost"]);

// Sortable wrapper for SessionItem (drag-to-reorder)
export function sessionCompositeKey(session: ExtendedSessionResponse): string {
	return `${session.peerId ?? "local"}:${session.id}`;
}

export function SortableSessionItem({
	session,
	index,
	isDraggable,
	...sessionItemProps
}: {
	session: ExtendedSessionResponse;
	index: number;
	isDraggable: boolean;
} & Omit<Parameters<typeof SessionItem>[0], "session">) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: sessionCompositeKey(session),
		disabled: !isDraggable,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
		zIndex: isDragging ? 10 : undefined,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			data-onboarding={index === 0 ? "session-item" : undefined}
		>
			<div className="flex items-stretch">
				{isDraggable && (
					<button
						type="button"
						className="flex items-center px-1 text-zinc-600 hover:text-zinc-400 touch-none cursor-grab active:cursor-grabbing"
						{...attributes}
						{...listeners}
					>
						<GripVertical className="w-4 h-4" />
					</button>
				)}
				<div className="flex-1 min-w-0">
					<SessionItem session={session} {...sessionItemProps} />
				</div>
			</div>
		</div>
	);
}


// Session item with long press to show menu
function SessionItem({
	session,
	onSelect,
	onSelectPane,
	onShowMenu,
	onResume,
	onDelete,
	onClosePane,
	onSelectTab,
	onCreateTab,
	onCloseTab,
}: {
	session: ExtendedSessionResponse;
	onSelect: (session: ExtendedSessionResponse) => void;
	onSelectPane?: (session: ExtendedSessionResponse, paneId: string) => void;
	onShowMenu: (session: ExtendedSessionResponse) => void;
	onResume?: (sessionId: string, ccSessionId?: string) => void;
	onDelete?: (sessionId: string, peerId?: string) => void;
	onShowConversation?: (
		ccSessionId: string,
		title: string,
		subtitle: string,
		isActive: boolean,
	) => void;
	onPaneAction?: (
		sessionId: string,
		action: "focus" | "close" | "split",
		paneId: string,
		direction?: "h" | "v",
	) => void;
	onClosePane?: (sessionId: string, paneId: string, name: string) => void;
	/** Switch the workspace to a tab. Awaited before opening a pane it owns. */
	onSelectTab?: (
		session: ExtendedSessionResponse,
		tabId: string,
	) => void | Promise<void>;
	onCreateTab?: (session: ExtendedSessionResponse) => void;
	onCloseTab?: (session: ExtendedSessionResponse, tabId: string, label: string) => void;
}) {
	const { t, i18n } = useTranslation();
	const longPressTimerRef = useRef<number | null>(null);
	const longPressFiredRef = useRef(false);

	const startLongPress = () => {
		longPressFiredRef.current = false;
		longPressTimerRef.current = window.setTimeout(() => {
			longPressFiredRef.current = true;
			onShowMenu(session);
		}, 600);
	};

	const cancelLongPress = () => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	};

	const handleTouchStart = () => {
		startLongPress();
	};

	const handleMouseDown = (e: React.MouseEvent) => {
		// Only handle left click
		if (e.button !== 0) return;
		startLongPress();
	};

	const handleContextMenu = (e: React.MouseEvent) => {
		// Prevent browser context menu on long press
		e.preventDefault();
	};

	const handleTouchEnd = () => {
		cancelLongPress();
	};

	const handleMouseUp = () => {
		cancelLongPress();
	};

	const handleMouseLeave = () => {
		// Cancel long press when mouse leaves the element
		cancelLongPress();
	};

	const handleTouchMove = () => {
		// Cancel long press when touch moves (scrolling)
		cancelLongPress();
	};

	const handleTouchCancel = () => {
		cancelLongPress();
		longPressFiredRef.current = false;
	};

	const [panesExpanded, setPanesExpanded] = useState(false);
	const [showJumpMenu, setShowJumpMenu] = useState(false);

	const handleClick = () => {
		if (longPressFiredRef.current) {
			longPressFiredRef.current = false;
			return;
		}
		longPressFiredRef.current = false;

		// Remote Control session: let the user choose between jumping to the Hrdle
		// terminal and opening the matching session in the Claude app.
		// Multi-pane sessions skip the session-level jump menu — "go to terminal"
		// is ambiguous there, so the actions live on the pane rows instead (row
		// tap navigates; the Claude-app link nests under the bridge pane).
		// Expandable when there is more than one pane OR more than one tab — the
		// expanded area lists both so the user can switch tabs / panes from here.
		const canExpand =
			(session.panes && session.panes.length > 1) ||
			(session.tabs && session.tabs.length > 1);

		if (session.bridgeSessionId) {
			if (canExpand) {
				setPanesExpanded((prev) => !prev);
			} else {
				setShowJumpMenu((prev) => !prev);
			}
			return;
		}

		// Multi-pane / multi-tab session: toggle the list to show tabs + panes
		if (canExpand) {
			setPanesExpanded((prev) => !prev);
			return;
		}

		onSelect(session);
	};

	const extSession = session;
	const agent = extSession.agent ?? extSession.currentCommand;
	const supportsConversationMetadata = agentSupportsConversationMetadata(agent);
	const agentLabel =
		agent && isAgentProvider(agent)
			? t(AGENT_PROVIDERS[agent].labelKey)
			: undefined;
	// Multi-pane / multi-tab workspace: a single card-header summary of
	// model/ctx/mem would be ambiguous, so those move to the per-pane rows.
	const isMultiWorkspace =
		(extSession.panes?.length ?? 0) > 1 || (extSession.tabs?.length ?? 0) > 1;
	// A single-tab workspace has no hierarchy worth drawing — its panes are
	// listed flat, with the "new tab" action still available underneath.
	const hasTabTree = (extSession.tabs?.length ?? 0) > 1;
	// ...but a collapsed card would then carry nothing but its badges, so one
	// pane stands in for the workspace until the rows themselves are on screen.
	const collapsedLead =
		isMultiWorkspace && !panesExpanded
			? pickLeadPane(extSession.panes ?? [])
			: undefined;
	// Derive card-level indicatorState from panes (priority: waiting_input > processing > idle)
	const cardIndicator: IndicatorState | undefined = (() => {
		if (extSession.panes && extSession.panes.length > 0) {
			if (extSession.panes.some((p) => p.indicatorState === "waiting_input"))
				return "waiting_input";
			if (extSession.panes.some((p) => p.indicatorState === "processing"))
				return "processing";
		}
		// Fallback to session-level indicatorState
		return extSession.indicatorState;
	})();

	// Use indicatorState (not waitingForInput) to determine badge display
	const isWaiting = cardIndicator === "waiting_input";
	const hasWaitingTool =
		!!extSession.waitingToolName && extSession.waitingToolName !== "UserInput";
	const waitingLabel =
		extSession.waitingToolName === "AskUserQuestion"
			? t("session.waitingQuestion")
			: extSession.waitingToolName === "EnterPlanMode"
				? t("session.waitingPlan")
				: extSession.waitingToolName === "ExitPlanMode"
					? t("session.waitingPlan")
					: extSession.waitingToolName === "UserInput"
						? t("session.waitingInput")
						: t("session.waitingPermission");
	const shortPath = toHomeShortPath(extSession.currentPath);

	// Use customTitle if set, otherwise use session name
	const displayTitle = session.customTitle ? session.customTitle : session.name;

	// Show resume button only when no agent is currently running and we have a
	// conversation id we can resume from (Claude → ccSessionId, Codex → agentSessionId).
	const isAgentRunning = !!extSession.agent;
	const showResumeButton =
		!isAgentRunning && (extSession.ccSessionId || extSession.agentSessionId);

	const handleResume = (e: React.MouseEvent) => {
		e.stopPropagation();
		onResume?.(session.id, extSession.ccSessionId);
	};

	// Show long-press hint only for first few visits
	const hintKey = storageKey("longpress-hint-seen");
	const hintSeen =
		typeof localStorage !== "undefined" && localStorage.getItem(hintKey);
	if (!hintSeen && typeof localStorage !== "undefined") {
		localStorage.setItem(hintKey, "1");
	}

	const isLost = session.state === "lost";
	const isLive =
		!isLost &&
		(cardIndicator === "processing" || cardIndicator === "waiting_input");
	// The peer color ranks below the theme: a peer color only says which server a
	// session lives on, so an explicit theme from the user wins.
	const peerAccentColor =
		extSession.peerId && extSession.peerId !== "local"
			? extSession.peerColor
			: undefined;
	const accentColor = session.theme
		? ACCENT_HEX[session.theme]
		: peerAccentColor;
	const peerBadge =
		extSession.peerNickname && extSession.peerId && extSession.peerId !== "local"
			? { nickname: extSession.peerNickname, color: extSession.peerColor ?? "#64748b" }
			: null;

	// Lost session: show recreate UI
	if (isLost) {
		return (
			<div className="group relative rounded-lg transition-all duration-200 select-none opacity-50 hover:opacity-70">
				{accentColor && (
					<div
						className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full"
						style={{ backgroundColor: accentColor }}
					/>
				)}
				<div className={`px-4 py-3 ${accentColor ? "pl-5" : ""}`}>
					<div className="flex items-center gap-2 mb-1">
						<h3 className="text-[15px] font-medium truncate flex-1 tracking-[-0.01em] text-zinc-500">
							{displayTitle}
						</h3>
						<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-500/15 text-zinc-500">
							{t("session.lost", "Lost")}
						</span>
					</div>
					{shortPath && (
						<p className="text-[12px] text-zinc-600 truncate mb-1.5">
							{shortPath}
						</p>
					)}
					{agentLabel && (
						<div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-500">
							<span className="inline-flex items-center px-2 py-0.5 rounded-full font-medium bg-zinc-500/15 text-zinc-500">
								{agentLabel}
							</span>
						</div>
					)}
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => onResume?.(session.id, extSession.ccSessionId)}
							className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors"
						>
							<Play className="w-3 h-3" />
							{t("session.resume", "Resume")}
						</button>
						<button
							type="button"
							onClick={() => onDelete?.(session.id, extSession.peerId)}
							className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium bg-zinc-600/20 text-zinc-400 hover:bg-red-600/20 hover:text-red-400 transition-colors"
						>
							<X className="w-3 h-3" />
							{t("common.delete", "Delete")}
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			onClick={handleClick}
			onTouchStart={handleTouchStart}
			onTouchMove={handleTouchMove}
			onTouchEnd={handleTouchEnd}
			onTouchCancel={handleTouchCancel}
			onMouseDown={handleMouseDown}
			onMouseUp={handleMouseUp}
			onMouseLeave={handleMouseLeave}
			onContextMenu={handleContextMenu}
			style={{
				touchAction: "pan-y",
				WebkitTouchCallout: "none",
				WebkitUserSelect: "none",
			}}
			className="group relative rounded-lg transition-all duration-200 cursor-pointer select-none hover:bg-white/[0.04] active:bg-white/[0.06]"
		>
			{/* Accent bar */}
			{accentColor && (
				<div
					className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full"
					style={{ backgroundColor: accentColor }}
				/>
			)}

			<div className={`px-4 py-3 ${accentColor ? "pl-5" : ""}`}>
				{/* Top row: title + path + status badges */}
				<div className="flex items-baseline gap-2 mb-1 min-w-0">
					<h3
						className={`text-[15px] font-medium truncate shrink-0 max-w-[55%] tracking-[-0.01em] ${
							isLive
								? "text-white"
								: supportsConversationMetadata
									? "text-zinc-300"
									: "text-zinc-400"
						}`}
					>
						{displayTitle}
					</h3>
					{shortPath && (
						<span className="text-[12px] text-zinc-500 truncate font-mono flex-1 min-w-0">
							{shortPath}
						</span>
					)}

					{/* Status badge - pill style */}
					{isWaiting && hasWaitingTool ? (
						<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-400">
							<span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
							{waitingLabel}
						</span>
					) : cardIndicator === "processing" ? (
						<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-500/15 text-blue-400">
							<span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
							{t("session.processing")}
						</span>
					) : showResumeButton ? (
						<button
							type="button"
							onClick={handleResume}
							onMouseDown={(e) => e.stopPropagation()}
							onTouchStart={(e) => e.stopPropagation()}
							className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
						>
							<Play className="w-3 h-3" />
							{t("session.resume")}
						</button>
					) : null}

					{/* Secondary badge: pane count (only if > 1) */}
					{extSession.panes && extSession.panes.length > 1 && (
						<span className="text-[11px] px-2 py-0.5 rounded-full shrink-0 text-cyan-400 bg-cyan-500/15">
							{t("session.panes", { count: extSession.panes.length })}
						</span>
					)}

					{/* Secondary badge: tab count (only if the workspace has > 1 tab) */}
					{extSession.tabs && extSession.tabs.length > 1 && (
						<span className="text-[11px] px-2 py-0.5 rounded-full shrink-0 text-violet-300 bg-violet-500/15">
							{t("session.tabsCount", { count: extSession.tabs.length })}
						</span>
					)}
				</div>

				{/* Auto recap (away_summary) — timestamp shown inline at the tail.
				    For a multi-pane/multi-tab workspace it moves to the per-pane
				    rows (like model/ctx/mem), so hide the header copy there. */}
				{!isMultiWorkspace && extSession.ccRecap && (
					<p className="mt-1 text-[12px] text-amber-200 leading-relaxed line-clamp-3">
						{extSession.ccRecap}
						{extSession.ccRecapAt && (
							<span className="ml-2 text-[10px] text-zinc-500">
								{formatRelativeTime(extSession.ccRecapAt, t, i18n.language)}
							</span>
						)}
					</p>
				)}

				{/* Last prompt / summary — hide when a recap is present (the recap
				    already covers it), including the lead pane's own recap below. */}
				{!extSession.ccRecap &&
					!collapsedLead?.recap &&
					(extSession.ccSummary || extSession.ccFirstPrompt) && (
						<p className="mt-1.5 text-[12px] text-zinc-600 leading-relaxed line-clamp-2">
							{extSession.ccSummary || extSession.ccFirstPrompt}
						</p>
					)}

				{/* Metadata row: agent / context / memory / tokens.
				    For a multi-pane/multi-tab workspace, model/ctx/mem move to the
				    per-pane rows (below), so only the peer badge stays here. */}
				{(peerBadge || (!isMultiWorkspace && (agentLabel || extSession.metrics))) && (
					<div className="mt-1.5 flex items-center gap-3 flex-wrap text-[11px] text-zinc-500">
						{peerBadge && (
							<span
								className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium"
								style={{
									backgroundColor: `${peerBadge.color}26`,
									color: peerBadge.color,
								}}
							>
								<span
									className="w-1.5 h-1.5 rounded-full"
									style={{ backgroundColor: peerBadge.color }}
								/>
								{peerBadge.nickname}
							</span>
						)}
						{!isMultiWorkspace && agentLabel && (
							<span className="inline-flex items-center px-2 py-0.5 rounded-full font-medium bg-zinc-500/15 text-zinc-400">
								{agentLabel}
								{extSession.metrics?.model && (
									<span
										className="ml-1.5 text-zinc-500"
										title={extSession.metrics.model}
									>
										{formatModelName(extSession.metrics.model)}
									</span>
								)}
							</span>
						)}
						{!isMultiWorkspace && extSession.metrics && (
							<ContextMeter metrics={extSession.metrics} />
						)}
						{!isMultiWorkspace && (
							<MemoryLabel bytes={extSession.metrics?.memoryRssBytes} />
						)}
					</div>
				)}

				{collapsedLead && (
					<CollapsedWorkspaceSummary
						lead={collapsedLead}
						panes={extSession.panes ?? []}
						tabs={extSession.tabs}
					/>
				)}

				{!hintSeen && (
					<div className="text-[11px] text-zinc-700 mt-1">
						{t("session.longPressHint")}
					</div>
				)}
			</div>

			{/* Jump menu (Remote Control): choose Hrdle terminal vs the Claude app.
			    Single-pane only — multi-pane sessions carry these actions per pane. */}
			{showJumpMenu &&
				extSession.bridgeSessionId &&
				(!extSession.panes || extSession.panes.length <= 1) && (
				<div
					className="mx-4 mb-3 pt-2 border-t border-white/[0.06] flex flex-col gap-1"
					onClick={(e) => e.stopPropagation()}
					onMouseDown={(e) => e.stopPropagation()}
					onTouchStart={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						onClick={() => {
							setShowJumpMenu(false);
							onSelect(session);
						}}
						className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-[13px] text-zinc-200 bg-white/[0.04] hover:bg-white/[0.08] transition-colors"
					>
						<ArrowRight className="w-3.5 h-3.5 text-zinc-400" />
						{t("session.goToTerminal")}
					</button>
					<button
						type="button"
						onClick={() => {
							const bridgeId = extSession.bridgeSessionId;
							if (!bridgeId) return;
							setShowJumpMenu(false);
							openClaudeAppSession(bridgeId);
						}}
						className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-[13px] text-violet-200 bg-violet-500/15 hover:bg-violet-500/25 transition-colors"
					>
						<ExternalLink className="w-3.5 h-3.5" />
						{t("session.openInClaudeApp")}
					</button>
				</div>
			)}

			{/* Tab / pane tree (expandable). herdr's model is workspace > tab >
			    pane, so the panes nest under the tab that owns them, every tab
			    showing its own. The terminal still renders one tab at a time, so
			    opening a pane parked in another one switches the workspace over
			    first — the tab row itself has nothing left to select. Long-press a
			    row to close it (tabs also get a hover ✕, since desktop has no long
			    press). */}
			{panesExpanded && (hasTabTree || extSession.panes) && (
				<div
					className="mx-4 mb-3 pt-2 border-t border-white/[0.06]"
					onClick={(e) => e.stopPropagation()}
					onMouseDown={(e) => e.stopPropagation()}
					onTouchStart={(e) => e.stopPropagation()}
				>
					{hasTabTree
						? extSession.tabs?.map((tab) => {
								const isActive =
									tab.active || extSession.activeTabId === tab.id;
								return (
									<div key={tab.id}>
										<TabRow
											session={session}
											tab={tab}
											isActive={isActive}
											canClose={(extSession.tabs?.length ?? 0) > 1}
											onCloseTab={onCloseTab}
										/>
										{/* `panes` spans every tab now, so each tab takes its
                        own. Rendering them all under the active one would
                        claim a pane belongs where it does not. A pane with no
                        tabId predates the field and stays with the active tab,
                        which is where it always appeared. */}
										{extSession.panes && (
											<div className="ml-4 pl-1 border-l border-white/[0.08]">
												{extSession.panes
													.filter((p) =>
														p.tabId ? p.tabId === tab.id : isActive,
													)
													.map((pane) => (
														<PaneRow
															key={pane.paneId}
															session={extSession}
															pane={pane}
															onSelect={onSelect}
															onSelectPane={onSelectPane}
															onClosePane={onClosePane}
															activateTab={
																isActive
																	? undefined
																	: () => onSelectTab?.(session, tab.id)
															}
														/>
													))}
											</div>
										)}
									</div>
								);
							})
						: extSession.panes?.map((pane) => (
								<PaneRow
									key={pane.paneId}
									session={extSession}
									pane={pane}
									onSelect={onSelect}
									onSelectPane={onSelectPane}
									onClosePane={onClosePane}
								/>
							))}
					{onCreateTab && (
						<button
							type="button"
							onClick={() => onCreateTab(session)}
							className="w-full min-h-11 flex items-center gap-2 px-2 rounded-md text-[12px] text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] transition-colors"
						>
							<Plus className="w-3.5 h-3.5 shrink-0" />
							{t("session.newTab")}
						</button>
					)}
				</div>
			)}

		</div>
	);
}
