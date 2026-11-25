/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import type { TFunction } from "i18next";
import { ChevronRight, ExternalLink, X } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { type ExtendedSessionResponse, type IndicatorState, isAgentProvider, type PaneInfo, type SessionMetrics, type TabInfo } from "../../../../shared/types";
import { openClaudeAppSession } from "../../utils/claude-app";
import { formatModelName, formatRelativeTime } from "../../utils/format";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatTokenCount(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

const AGENT_NAME_COLORS: Record<string, string> = {
	red: "text-red-300",
	orange: "text-orange-300",
	amber: "text-amber-300",
	green: "text-green-300",
	teal: "text-teal-300",
	blue: "text-blue-300",
	cyan: "text-cyan-300",
	indigo: "text-indigo-300",
	purple: "text-purple-300",
	pink: "text-pink-300",
};

/**
 * Long-press (600ms) handlers shared by the tab / pane rows. The timer lives in
 * a ref because the session list re-renders on every 5s server push: a render
 * mid-press would hand the DOM fresh handlers whose local timer is null, so the
 * pending close would never be cancelled on release.
 */
function useRowLongPress(onLongPress: (() => void) | undefined) {
	const timerRef = useRef<number | null>(null);
	const firedRef = useRef(false);

	const cancel = () => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	};

	return {
		/** True when the press already fired as a long press — the click is a no-op. */
		consumeLongPress: () => {
			if (!firedRef.current) return false;
			firedRef.current = false;
			return true;
		},
		handlers: {
			onTouchStart: () => {
				firedRef.current = false;
				if (!onLongPress) return;
				timerRef.current = window.setTimeout(() => {
					timerRef.current = null;
					firedRef.current = true;
					onLongPress();
				}, 600);
			},
			onTouchEnd: cancel,
			onTouchMove: cancel,
			onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
		},
	};
}

/**
 * A name the user typed outranks one we derived: `herdr pane rename` is them
 * saying what the pane is for, where `claude` only says what is running.
 */
function paneDisplayName(pane: PaneInfo): string {
	return pane.label || pane.agentName || pane.currentCommand || "shell";
}

function paneNameColorClass(pane: PaneInfo): string {
	if (pane.agentColor && AGENT_NAME_COLORS[pane.agentColor]) {
		return AGENT_NAME_COLORS[pane.agentColor];
	}
	const isAgentPane =
		isAgentProvider(pane.currentCommand ?? "") || !!pane.agentName;
	return isAgentPane ? "text-green-300" : "text-zinc-300";
}

function paneDotClass(state: IndicatorState | undefined): string {
	return state === "processing"
		? "bg-blue-400"
		: state === "waiting_input"
			? "bg-yellow-400 animate-pulse"
			: "bg-zinc-600";
}

/**
 * herdr labels a tab with its number until it is renamed. "Tab 3" reads better
 * than a bare "3", but a renamed tab ("Recipes") wants no prefix.
 */
function tabDisplayLabel(label: string, t: TFunction): string {
	return /^\d+$/.test(label) ? `${t("session.tab")} ${label}` : label;
}

/**
 * The pane a collapsed card speaks for. Priority is what the user would have to
 * act on: a pane waiting on them, then one still working, then whichever spoke
 * most recently.
 */
export function pickLeadPane(panes: PaneInfo[]): PaneInfo | undefined {
	const rank = (p: PaneInfo) =>
		p.indicatorState === "waiting_input"
			? 0
			: p.indicatorState === "processing"
				? 1
				: 2;
	const spokeAt = (p: PaneInfo) => (p.recapAt ? Date.parse(p.recapAt) : 0);
	// sort() is stable, so panes that tie on every key keep herdr's order.
	return [...panes].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			spokeAt(b) - spokeAt(a) ||
			Number(b.isActive) - Number(a.isActive),
	)[0];
}

/**
 * Context-window gauge. The card header, the pane rows and the collapsed
 * summary all draw the same one — the color thresholds are what make it
 * readable at a glance, so they live in a single place.
 */
export function ContextMeter({ metrics }: { metrics: SessionMetrics }) {
	if (typeof metrics.contextPercent !== "number") return null;
	const percent = metrics.contextPercent;
	return (
		<div
			className="inline-flex items-center gap-1.5"
			title={`${formatTokenCount(metrics.contextTokens ?? 0)} / ${formatTokenCount(metrics.contextMaxTokens ?? 0)}`}
		>
			<span className="text-zinc-600">ctx</span>
			<div className="w-14 h-1 bg-white/10 rounded-full overflow-hidden">
				<div
					className={`h-full transition-all ${
						percent >= 80
							? "bg-red-500"
							: percent >= 60
								? "bg-amber-500"
								: "bg-emerald-500"
					}`}
					style={{ width: `${Math.max(2, percent)}%` }}
				/>
			</div>
			<span className="font-mono tabular-nums">{percent.toFixed(1)}%</span>
		</div>
	);
}

export function MemoryLabel({ bytes }: { bytes?: number }) {
	if (typeof bytes !== "number" || bytes <= 0) return null;
	return (
		<span className="font-mono tabular-nums" title={`${bytes} bytes`}>
			<span className="text-zinc-600">mem</span> {formatBytes(bytes)}
		</span>
	);
}

/**
 * What a multi-pane / multi-tab workspace says while collapsed.
 *
 * Model, ctx and recap live on the pane rows because one card-level number
 * cannot say which pane it describes — but that left the busiest workspaces as
 * the least informative rows in the list: a title, a "3 panes" badge, nothing
 * else. So the pane that most wants attention speaks for the card, and the
 * others shrink to a chip carrying only their state and context use.
 */
export function CollapsedWorkspaceSummary({
	lead,
	panes,
	tabs,
}: {
	lead: PaneInfo;
	panes: PaneInfo[];
	tabs?: TabInfo[];
}) {
	const { t, i18n } = useTranslation();
	const rest = panes.filter((p) => p.paneId !== lead.paneId);
	const leadTab =
		tabs && tabs.length > 1
			? tabs.find((tab) => tab.id === lead.tabId)
			: undefined;

	return (
		<div className="mt-1.5">
			<div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] text-zinc-500">
				<span className="inline-flex items-center gap-1.5 min-w-0">
					<span
						className={`w-1.5 h-1.5 rounded-full shrink-0 ${paneDotClass(lead.indicatorState)}`}
					/>
					<span
						className={`text-[12px] font-medium truncate ${paneNameColorClass(lead)}`}
					>
						{paneDisplayName(lead)}
					</span>
				</span>
				{leadTab && (
					<span className="text-zinc-600 shrink-0">
						{tabDisplayLabel(leadTab.label, t)}
					</span>
				)}
				{lead.metrics?.model && (
					<span title={lead.metrics.model}>
						{formatModelName(lead.metrics.model)}
					</span>
				)}
				{lead.metrics && <ContextMeter metrics={lead.metrics} />}
				<MemoryLabel bytes={lead.metrics?.memoryRssBytes} />
			</div>
			{lead.recap && (
				<p className="mt-1 text-[12px] text-amber-200 leading-relaxed line-clamp-2">
					{lead.recap}
					{lead.recapAt && (
						<span className="ml-2 text-[10px] text-zinc-500">
							{formatRelativeTime(lead.recapAt, t, i18n.language)}
						</span>
					)}
				</p>
			)}
			{rest.length > 0 && (
				<div className="mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px]">
					{rest.map((pane) => (
						<span
							key={pane.paneId}
							className="inline-flex items-center gap-1.5 min-w-0"
						>
							<span
								className={`w-1.5 h-1.5 rounded-full shrink-0 ${paneDotClass(pane.indicatorState)}`}
							/>
							<span className="truncate max-w-[9rem] text-zinc-400">
								{paneDisplayName(pane)}
							</span>
							{typeof pane.metrics?.contextPercent === "number" && (
								<span className="font-mono tabular-nums text-zinc-600 shrink-0">
									{pane.metrics.contextPercent.toFixed(1)}%
								</span>
							)}
						</span>
					))}
				</div>
			)}
		</div>
	);
}

/** One pane of a tab: status dot, agent name, then its metrics and recap. */
export function PaneRow({
	session,
	pane,
	onSelect,
	onSelectPane,
	onClosePane,
	activateTab,
}: {
	session: ExtendedSessionResponse;
	pane: PaneInfo;
	onSelect: (session: ExtendedSessionResponse) => void;
	onSelectPane?: (session: ExtendedSessionResponse, paneId: string) => void;
	onClosePane?: (sessionId: string, paneId: string, name: string) => void;
	/**
	 * Set only when this pane sits in a tab the workspace is not rendering.
	 * Awaited before opening the pane so the terminal is already on the right
	 * tab by the time it subscribes.
	 */
	activateTab?: () => void | Promise<void>;
}) {
	const { t, i18n } = useTranslation();
	const displayName = paneDisplayName(pane);
	const nameColor = paneNameColorClass(pane);
	const paneIndicator = pane.indicatorState;
	const dotClass = paneDotClass(paneIndicator);

	const { consumeLongPress, handlers } = useRowLongPress(
		onClosePane
			? () => onClosePane(session.id, pane.paneId, displayName)
			: undefined,
	);

	return (
		<div>
			<button
				type="button"
				onClick={async () => {
					if (consumeLongPress()) return;
					// A pane in another tab is only readable from here; the terminal
					// shows one tab at a time. Switch before opening it, or the tap
					// lands on some other tab's pane.
					if (activateTab) await activateTab();
					if (onSelectPane) {
						onSelectPane(session, pane.paneId);
					} else {
						onSelect(session);
					}
				}}
				{...handlers}
				className="w-full min-h-11 flex items-center gap-2 px-3 py-1.5 rounded-md text-left transition-colors hover:bg-white/[0.04]"
			>
				<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
				<span className={`text-[13px] font-medium truncate ${nameColor}`}>
					{displayName}
				</span>
				{!pane.agentName && <span className="flex-1" />}
				{paneIndicator === "processing" && (
					<span className="text-[10px] text-blue-400 bg-blue-500/15 px-1.5 py-0.5 rounded-full shrink-0">
						{t("session.processing")}
					</span>
				)}
				{pane.isActive && (
					<span className="text-[10px] text-cyan-400 bg-cyan-500/15 px-1.5 py-0.5 rounded-full shrink-0">
						{t("session.paneFocused")}
					</span>
				)}
				<ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
			</button>
			{pane.metrics && (
				<div className="ml-6 flex items-center gap-3 flex-wrap text-[11px] text-zinc-500">
					{pane.metrics.model && (
						<span className="text-zinc-500" title={pane.metrics.model}>
							{formatModelName(pane.metrics.model)}
						</span>
					)}
					<ContextMeter metrics={pane.metrics} />
					<MemoryLabel bytes={pane.metrics.memoryRssBytes} />
				</div>
			)}
			{pane.recap && (
				<p className="ml-6 mt-0.5 mb-1 text-[12px] text-zinc-400 leading-relaxed line-clamp-2">
					{pane.recap}
					{pane.recapAt && (
						<span className="ml-2 text-[10px] text-zinc-600">
							{formatRelativeTime(pane.recapAt, t, i18n.language)}
						</span>
					)}
				</p>
			)}
			{pane.bridgeSessionId && (
				<button
					type="button"
					onClick={() => {
						const bridgeId = pane.bridgeSessionId;
						if (!bridgeId) return;
						openClaudeAppSession(bridgeId);
					}}
					className="ml-6 mt-1 mb-1 inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] text-violet-200 bg-violet-500/15 hover:bg-violet-500/25 transition-colors"
				>
					<ExternalLink className="w-3.5 h-3.5" />
					{t("session.openInClaudeApp")}
				</button>
			)}
		</div>
	);
}

/**
 * The heading a tab's panes sit under. Every tab lists its panes, so there is
 * nothing here to open or expand — tapping a pane is what switches the
 * workspace to the tab that owns it. The highlight marks the tab the terminal
 * is currently rendering; the row itself only closes (long press, or the ✕ on
 * hover for desktop, which has no long press).
 */
export function TabRow({
	session,
	tab,
	isActive,
	canClose,
	onCloseTab,
}: {
	session: ExtendedSessionResponse;
	tab: TabInfo;
	isActive: boolean;
	canClose: boolean;
	onCloseTab?: (
		session: ExtendedSessionResponse,
		tabId: string,
		label: string,
	) => void;
}) {
	const { t } = useTranslation();
	const label = tabDisplayLabel(tab.label, t);

	const closeTab =
		canClose && onCloseTab
			? () => onCloseTab(session, tab.id, tab.label)
			: undefined;
	const { handlers } = useRowLongPress(closeTab);

	return (
		<div className="group/tab flex items-center gap-1">
			<div
				{...handlers}
				className={`flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-md ${
					isActive ? "bg-cyan-500/10" : ""
				}`}
			>
				<span
					className={`text-[13px] font-medium truncate ${
						isActive ? "text-cyan-200" : "text-zinc-400"
					}`}
				>
					{label}
				</span>
				<span className="flex-1" />
				<span className="text-[11px] text-zinc-600 shrink-0">
					{t("session.panes", { count: tab.paneCount })}
				</span>
			</div>
			{/* Desktop only. opacity-0 still takes hit tests, so on a phone — where
			    the hover that reveals it never happens — this left an invisible
			    26px "close tab" target at the row's edge. Touch closes by long
			    press instead. */}
			{closeTab && (
				<button
					type="button"
					onClick={closeTab}
					title={t("session.closeTabTitle")}
					aria-label={t("session.closeTabTitle")}
					className="hidden [@media(hover:hover)]:flex shrink-0 min-h-11 px-2.5 items-center justify-center rounded-md text-zinc-600 opacity-0 transition-opacity hover:text-red-400 hover:bg-red-500/10 group-hover/tab:opacity-100 focus-visible:opacity-100"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			)}
		</div>
	);
}
