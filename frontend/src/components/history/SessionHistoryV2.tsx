import { Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionResponse } from "../../../../shared/types";
import {
	sessionDedupeKey,
	useFlatHistoryItems,
} from "../../hooks/useFlatHistoryItems";
import { useHistoryActions } from "../../hooks/useHistoryActions";
import { useSessionHistory } from "../../hooks/useSessionHistory";
import { bucketizeHistory } from "../../utils/historyBuckets";
import {
	type ActiveChip,
	activeChips,
	applyFacets,
	applyPeriodFilter,
	computeFacetData,
	emptyFacetState,
	type FacetState,
	isFacetActive,
} from "../../utils/historyFacets";
import { ConversationViewer } from "../ConversationViewer";
import { HistoryActiveChips } from "./HistoryActiveChips";
import { HistoryFacetDrawer } from "./HistoryFacetDrawer";
import { HistoryFacetSidebar } from "./HistoryFacetSidebar";
import { VirtualizedHistoryList } from "./VirtualizedHistoryList";
import { storageKey } from "../../utils/app-storage";

interface ActiveSession extends SessionResponse {
	ccSessionId?: string;
}

interface SessionHistoryV2Props {
	onSessionResumed?: () => void;
	onSelectSession?: (session: SessionResponse) => void;
	activeSessions?: ActiveSession[];
}

const SIDEBAR_MIN_WIDTH = 760;

const SIDEBAR_WIDTH_KEY = storageKey("history-sidebar-width");
const SIDEBAR_WIDTH_DEFAULT = 240;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 480;

function loadSidebarWidth(): number {
	const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
	if (!Number.isFinite(raw) || raw <= 0) return SIDEBAR_WIDTH_DEFAULT;
	return Math.max(SIDEBAR_WIDTH_MIN, Math.min(raw, SIDEBAR_WIDTH_MAX));
}

function facetKey(s: FacetState): string {
	return JSON.stringify({
		p: [...s.projects].sort(),
		a: [...s.agents].sort(),
		b: [...s.branches].sort(),
		pe: [...s.peers].sort(),
		period: s.period,
	});
}

/**
 * V2 history view: a cross-project flat list (virtualized, date-bucketed, with
 * recap previews and incremental search) plus a faceted filter sidebar that
 * collapses to a bottom-sheet drawer on narrow screens.
 */
export function SessionHistoryV2({
	onSessionResumed,
	onSelectSession,
	activeSessions = [],
}: SessionHistoryV2Props) {
	const { t } = useTranslation();
	const {
		projects,
		isLoadingProjects,
		sessionsByProject,
		fetchProjectSessions,
		refreshAllLoadedProjects,
		searchResults,
		isSearching,
		searchQuery,
		searchSessions,
		resumeSession,
		fetchConversation,
		error,
	} = useSessionHistory();

	const { items, dirNameBySession, isHydrating, hydratedCount, totalCount } =
		useFlatHistoryItems({
			projects,
			sessionsByProject,
			fetchProjectSessions,
		});

	const {
		resumingId,
		resumeError,
		selectedSession,
		conversation,
		loadingConversation,
		activeCcSessionIds,
		handleResume,
		handleNavigate,
		handleTap,
		closeModal,
		dismissError,
	} = useHistoryActions({
		activeSessions,
		onSelectSession,
		onSessionResumed,
		resumeSession,
		fetchConversation,
		refreshAllLoadedProjects,
	});

	// Incremental search: debounce keystrokes into the existing SSE search.
	const [searchInput, setSearchInput] = useState("");
	useEffect(() => {
		const q = searchInput.trim();
		const handle = setTimeout(() => {
			searchSessions(q);
		}, 150);
		return () => clearTimeout(handle);
	}, [searchInput, searchSessions]);

	// Faceted filter state + responsive sidebar/drawer.
	const [facet, setFacet] = useState<FacetState>(() => emptyFacetState());
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [wide, setWide] = useState(false);
	// Callback ref so the observer attaches whenever the root actually mounts —
	// the loading/error early-returns render a ref-less node first, so a
	// once-only effect would never see the real root and `wide` would stay false.
	const roRef = useRef<ResizeObserver | null>(null);
	const setRootRef = useCallback((el: HTMLDivElement | null) => {
		roRef.current?.disconnect();
		roRef.current = null;
		if (!el) return;
		const compute = () => setWide(el.clientWidth >= SIDEBAR_MIN_WIDTH);
		compute();
		const ro = new ResizeObserver(compute);
		ro.observe(el);
		roRef.current = ro;
	}, []);

	// Close the drawer when we switch to the inline sidebar so it doesn't
	// ghost-reopen if the viewport narrows again.
	useEffect(() => {
		if (wide) setDrawerOpen(false);
	}, [wide]);

	// Drag-resizable sidebar width, persisted across sessions.
	const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
	const isResizingSidebar = useRef(false);
	const bodyRef = useRef<HTMLDivElement>(null);

	const handleSidebarResizeStart = useCallback(
		(e: React.MouseEvent | React.TouchEvent) => {
			e.preventDefault();
			isResizingSidebar.current = true;
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
		},
		[],
	);

	useEffect(() => {
		const handleMove = (e: MouseEvent | TouchEvent) => {
			if (!isResizingSidebar.current || !bodyRef.current) return;
			const rect = bodyRef.current.getBoundingClientRect();
			const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
			const width = Math.max(
				SIDEBAR_WIDTH_MIN,
				Math.min(clientX - rect.left, SIDEBAR_WIDTH_MAX, rect.width - 320),
			);
			setSidebarWidth(width);
			localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
		};
		const handleEnd = () => {
			if (isResizingSidebar.current) {
				isResizingSidebar.current = false;
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
			}
		};
		document.addEventListener("mousemove", handleMove);
		document.addEventListener("mouseup", handleEnd);
		document.addEventListener("touchmove", handleMove);
		document.addEventListener("touchend", handleEnd);
		return () => {
			document.removeEventListener("mousemove", handleMove);
			document.removeEventListener("mouseup", handleEnd);
			document.removeEventListener("touchmove", handleMove);
			document.removeEventListener("touchend", handleEnd);
		};
	}, []);

	const isSearchMode = searchQuery.trim().length > 0;
	const sourceItems = isSearchMode ? searchResults : items;

	// Facet value lists + counts are scoped to the selected period, so the
	// other axes only offer (and count) values inside the date range. Selected
	// values are pinned at count 0 so they can still be unchecked.
	const facetData = useMemo(
		() => computeFacetData(applyPeriodFilter(items, facet.period, Date.now()), t, facet),
		[items, facet, t],
	);
	const chips: ActiveChip[] = useMemo(
		() => activeChips(facet, facetData, t),
		[facet, facetData, t],
	);

	// facet -> sort -> bucketize into header+session rows for the virtualizer.
	const rows = useMemo(() => {
		const now = Date.now();
		const filtered = applyFacets(sourceItems, facet, now);
		// The flat list is already modified-DESC, but search results arrive in SSE
		// order — sort so bucket headers don't repeat / collide on keys.
		const ordered = isSearchMode
			? [...filtered].sort(
					(a, b) =>
						new Date(b.modified).getTime() - new Date(a.modified).getTime(),
				)
			: filtered;
		return bucketizeHistory(
			ordered,
			isSearchMode ? undefined : dirNameBySession,
			sessionDedupeKey,
			t,
			now,
		);
	}, [sourceItems, facet, isSearchMode, dirNameBySession, t]);

	const facetActive = isFacetActive(facet);
	const sessionCount = rows.reduce(
		(n, r) => (r.kind === "session" ? n + 1 : n),
		0,
	);

	const removeChip = (chip: ActiveChip) => {
		if (chip.axis === "period") {
			setFacet((s) => ({ ...s, period: null }));
			return;
		}
		setFacet((s) => {
			const next = new Set(s[chip.axis]);
			next.delete(chip.value);
			return { ...s, [chip.axis]: next };
		});
	};
	const clearAll = () => setFacet(emptyFacetState());

	if (isLoadingProjects) {
		return (
			<div className="bg-cv-bg p-6 text-center text-sm text-cv-text-muted">
				{t("history.loadingHistory")}
			</div>
		);
	}

	if (error) {
		return (
			<div className="bg-cv-bg p-6 text-center text-sm text-red-400">
				{t("common.error")}: {error}
			</div>
		);
	}

	const sidebar = (
		<HistoryFacetSidebar data={facetData} state={facet} onChange={setFacet} />
	);

	return (
		<div ref={setRootRef} className="flex h-full flex-col bg-cv-bg">
			{/* Header: search + (narrow) Filters button */}
			<div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
				<div className="relative max-w-sm flex-1">
					<Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cv-text-muted" />
					<input
						type="text"
						value={searchInput}
						onChange={(e) => setSearchInput(e.target.value)}
						placeholder={t("history.searchPlaceholder")}
						className="w-full rounded-full border border-cv-border bg-cv-surface py-1.5 pl-9 pr-3 text-[13px] text-cv-text transition-colors placeholder:text-cv-text-muted focus:border-cv-accent/50 focus:outline-none"
					/>
					{searchInput && (
						<button
							type="button"
							onClick={() => setSearchInput("")}
							className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-cv-text-muted hover:text-cv-text"
						>
							<X className="h-3.5 w-3.5" />
						</button>
					)}
				</div>
				{!wide && (
					<button
						type="button"
						onClick={() => setDrawerOpen(true)}
						className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-cv-border px-3 py-1.5 text-[12px] text-cv-text-secondary transition-colors hover:bg-cv-surface"
					>
						<SlidersHorizontal className="h-3.5 w-3.5" />
						{t("history.filters")}
						{chips.length > 0 && (
							<span className="rounded-full bg-cv-accent px-1.5 text-[10px] tabular-nums text-white">
								{chips.length}
							</span>
						)}
					</button>
				)}
			</div>

			{/* Active facet chips */}
			{chips.length > 0 && (
				<div className="shrink-0 px-4 pb-2">
					<HistoryActiveChips
						chips={chips}
						onRemove={removeChip}
						onClearAll={clearAll}
					/>
				</div>
			)}

			{/* Body: sidebar (wide) + list */}
			<div ref={bodyRef} className="flex-1 min-h-0 flex">
				{wide && (
					<>
						<aside
							style={{ width: sidebarWidth }}
							className="shrink-0 overflow-y-auto border-r border-cv-border px-4 py-3"
						>
							{sidebar}
						</aside>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle */}
						<div
							className="-ml-0.5 w-1 shrink-0 cursor-col-resize touch-none transition-colors hover:bg-cv-accent/50"
							onMouseDown={handleSidebarResizeStart}
							onTouchStart={handleSidebarResizeStart}
						/>
					</>
				)}
				<div className="flex-1 min-h-0 flex flex-col">
					{/* Status line */}
					<div className="shrink-0 px-4 py-1.5 text-[11px] text-cv-text-muted">
						{isSearchMode ? (
							isSearching ? (
								t("history.searching")
							) : (
								t("history.searchResults", {
									query: searchQuery,
									count: sessionCount,
								})
							)
						) : isHydrating ? (
							t("history.indexing", { done: hydratedCount, total: totalCount })
						) : (
							t("history.sessionsCount", { count: sessionCount })
						)}
					</div>

					{resumeError && (
						<div className="mx-4 mt-2 flex shrink-0 items-center justify-between rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-400">
							<span>{resumeError}</span>
							<button
								type="button"
								onClick={dismissError}
								className="ml-2 text-red-400 hover:opacity-70"
							>
								×
							</button>
						</div>
					)}

					<div className="flex-1 min-h-0">
						{rows.length === 0 ? (
							<div className="p-8 text-center text-sm text-cv-text-muted">
								{isSearchMode
									? t("history.noSearchResults")
									: facetActive
										? t("history.noFilterMatches")
										: t("history.noSessions")}
							</div>
						) : (
							<VirtualizedHistoryList
								// Remount on mode flip AND facet change so scrollTop +
								// measurement cache reset; otherwise a stale offset can leave
								// the list blank after the row set shrinks.
								key={isSearchMode ? "search" : `flat:${facetKey(facet)}`}
								rows={rows}
								activeCcSessionIds={activeCcSessionIds}
								resumingId={resumingId}
								onTap={handleTap}
								onResume={handleResume}
								onNavigate={handleNavigate}
							/>
						)}
					</div>
				</div>
			</div>

			{!wide && (
				<HistoryFacetDrawer
					open={drawerOpen}
					onClose={() => setDrawerOpen(false)}
				>
					{sidebar}
				</HistoryFacetDrawer>
			)}

			{selectedSession && (
				<ConversationViewer
					title={
						selectedSession.summary ||
						selectedSession.lastPrompt ||
						selectedSession.firstPrompt ||
						t("history.noTitle")
					}
					subtitle={selectedSession.projectName}
					messages={conversation}
					isLoading={loadingConversation}
					onClose={closeModal}
					onResume={() => handleResume(selectedSession)}
					isResuming={resumingId === selectedSession.sessionId}
					scrollToBottom={true}
				/>
			)}
		</div>
	);
}
