import { Bot, Globe, MessagesSquare, Moon, Server, SlidersHorizontal, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IDENTITY } from "../../../../shared/identity";
import { agentDisplayName } from "../../../../shared/types";
import { useDashboard } from "../../hooks/useDashboard";
import { usePeers } from "../../hooks/usePeers";
import {
	CHAT_FONT_DEFAULT,
	useChatFontSize,
} from "../../hooks/useChatFontSize";
import { useStewardEnabled, useStewardView } from "../../hooks/useSteward";
import { useTheme } from "../../hooks/useTheme";
import { useUiScale } from "../../hooks/useUiScale";
import { formatTokens, formatUsd } from "../../utils/format";
import { nukeClientCache } from "../../utils/nuke-cache";
import { Card, StatTile } from "./Card";
import { DailyUsageChart } from "./DailyUsageChart";
import { SttUsageCard } from "./SttUsageCard";
import { HourlyHeatmap } from "./HourlyHeatmap";
import { KimiDailyCostChart } from "./KimiDailyCostChart";
import { ModelUsageChart } from "./ModelUsageChart";
import { PeerServerCard } from "./PeerServerCard";
import { UsageLimits } from "./UsageLimits";
import { storageKey } from "../../utils/app-storage";

// Onboarding localStorage keys
const ONBOARDING_KEY = storageKey("onboarding-completed");
const ONBOARDING_SESSIONLIST_KEY = storageKey("onboarding-sessionlist-completed");

interface DashboardProps {
	className?: string;
	compact?: boolean; // true when in narrow side panel
}

type AgentTab = "claude" | "codex" | "grok" | "kimi" | "opencode";

/**
 * One section header, so the three sections read as three sections. The
 * settings block used to be a bare divider with buttons under it, which made
 * the panel look like it ended at "server status" and then kept going.
 */
function SectionHeading({
	id,
	icon,
	children,
	aside,
}: {
	id: string;
	icon: ReactNode;
	children: ReactNode;
	aside?: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
			<div className="flex items-center gap-2">
				{icon}
				<h2 id={id} className="text-xs font-medium text-th-text-secondary">
					{children}
				</h2>
			</div>
			{aside}
		</div>
	);
}

const ICON_CLASS = "w-3.5 h-3.5 text-th-text-muted";
/** The two-column grid the wide layout uses; a compact panel just stacks. */
const gridClass = (compact: boolean) =>
	compact ? "space-y-3" : "md:grid md:grid-cols-2 md:gap-3 space-y-3 md:space-y-0";

export function Dashboard({ className = "", compact = false }: DashboardProps) {
	const { t, i18n } = useTranslation();
	const { peers } = usePeers();
	const sortedPeers = useMemo(
		() => [...peers].sort((a, b) => a.order - b.order),
		[peers],
	);
	const { data, isLoading, error } = useDashboard(30000);
	const { theme, toggleTheme } = useTheme();
	const stewardAvailable = useStewardEnabled();
	const { fontSize: chatFontSize, changeFontSize: changeChatFontSize, resetFontSize: resetChatFontSize } =
		useChatFontSize();
	const [stewardView, setStewardView] = useStewardView();
	const {
		scale: uiScale,
		setScale: setUiScale,
		options: uiScaleOptions,
	} = useUiScale();
	const [showResetConfirm, setShowResetConfirm] = useState(false);
	const [cacheClearing, setCacheClearing] = useState(false);
	const [agentTab, setAgentTab] = useState<AgentTab>("claude");
	const codexLimits = data?.codexUsageLimits;
	const grokUsage = data?.grokUsage;
	const kimiUsage = data?.kimiUsage;
	const opencodeUsage = data?.opencodeUsage;
	const openRouterUsage = data?.openRouterUsage;
	const sttUsage = data?.sttUsage;
	// Claude is "available" when we have any actionable Claude data. The endpoint
	// returns empty arrays / no-credentials errors on a Codex-only machine.
	const claudeAvailable =
		!!data &&
		(!!data.usageLimits ||
			(data.dailyActivity?.length ?? 0) > 0 ||
			(data.modelUsage?.length ?? 0) > 0);
	// Tabs render for every provider that has usage data. With one provider
	// (or none) the tab bar is hidden and that provider is forced.
	const availableTabs: AgentTab[] = [
		...(claudeAvailable ? (["claude"] as const) : []),
		...(codexLimits ? (["codex"] as const) : []),
		...(grokUsage ? (["grok"] as const) : []),
		// OpenRouter spend alone is enough: the key comes from the Kimi config, so
		// billed usage is worth showing even before any session lands in the window.
		...(kimiUsage || openRouterUsage ? (["kimi"] as const) : []),
		...(opencodeUsage ? (["opencode"] as const) : []),
	];
	const showAgentTabs = availableTabs.length > 1;
	const effectiveTab: AgentTab = availableTabs.includes(agentTab)
		? agentTab
		: (availableTabs[0] ?? "claude");

	const handleClearCache = useCallback(async () => {
		setCacheClearing(true);
		try {
			await nukeClientCache();
		} catch (e) {
			console.error("Cache clear failed:", e);
			setCacheClearing(false);
		}
	}, []);

	const handleResetOnboarding = () => {
		localStorage.removeItem(ONBOARDING_KEY);
		localStorage.removeItem(ONBOARDING_SESSIONLIST_KEY);
		setShowResetConfirm(false);
		window.location.reload();
	};

	if (isLoading && !data) {
		return (
			<div className={`p-2 ${className}`}>
				<div className="text-th-text-muted text-xs animate-pulse">
					{t("common.loading")}
				</div>
			</div>
		);
	}

	if (error && !data) {
		return (
			<div className={`p-2 ${className}`}>
				<div className="text-red-400 text-xs">
					{t("common.error")}: {error}
				</div>
			</div>
		);
	}

	return (
		<div
			className={`overflow-y-auto overscroll-contain px-4 py-4 ${className}`}
		>
			<section aria-labelledby="dashboard-agent-usage">
				<SectionHeading
					id="dashboard-agent-usage"
					icon={<Bot className={ICON_CLASS} />}
					aside={
						showAgentTabs && (
							<div
								className="flex gap-1 text-xs"
								role="tablist"
								aria-label={t("dashboard.agentUsage")}
							>
								{availableTabs.map((id) => {
									const isActive = effectiveTab === id;
									const label = agentDisplayName(id);
									return (
										<button
											key={id}
											type="button"
											role="tab"
											aria-selected={isActive}
											onClick={() => setAgentTab(id)}
											className={`px-3 py-1.5 rounded-md transition-colors ${
												isActive
													? "bg-white/[0.08] text-th-text"
													: "bg-white/[0.03] text-th-text-muted hover:text-th-text hover:bg-white/[0.05]"
											}`}
										>
											{label}
										</button>
									);
								})}
							</div>
						)
					}
				>
					{t("dashboard.agentUsage")}
				</SectionHeading>

				{effectiveTab === "grok" ? (
					<div className={gridClass(compact)}>
						<Card
							className="md:col-span-2"
							title={t("dashboard.grokUsage")}
							aside={
								grokUsage?.planType && (
									<span className="px-1.5 py-px rounded border text-[10px] font-medium text-emerald-300 bg-emerald-400/10 border-emerald-400/20 shrink-0">
										{grokUsage.planType}
									</span>
								)
							}
							footnote={t("dashboard.grokNoRateLimitInfo")}
						>
							<div className="grid grid-cols-2 gap-2.5">
								{(
									[
										["grokLast24h", grokUsage?.last24h],
										["grokLast7d", grokUsage?.last7d],
									] as const
								).map(([labelKey, window]) => (
									<StatTile key={labelKey} label={t(`dashboard.${labelKey}`)}>
										<div className="text-lg font-semibold text-th-text tabular-nums">
											{formatTokens(window?.totalTokens ?? 0)}
										</div>
										<div className="text-[11px] text-th-text-muted">
											{t("dashboard.grokTurns", { count: window?.turns ?? 0 })}
										</div>
									</StatTile>
								))}
							</div>
							{(grokUsage?.models.length ?? 0) > 0 && (
								<div className="mt-3 space-y-1">
									<div className="text-[11px] text-th-text-muted">
										{t("dashboard.grokModelBreakdown")}
									</div>
									{grokUsage?.models.map((m) => (
										<div
											key={m.model}
											className="flex justify-between text-xs text-th-text-secondary"
										>
											<span className="truncate">{m.model}</span>
											<span className="shrink-0 tabular-nums">
												{formatTokens(m.totalTokens)}
											</span>
										</div>
									))}
								</div>
							)}
						</Card>
					</div>
				) : effectiveTab === "kimi" ? (
					<div className={gridClass(compact)}>
						<Card
							className="md:col-span-2"
							title={t("dashboard.kimiUsage")}
							footnote={t("dashboard.kimiNoRateLimitInfo")}
						>
							<div className="grid grid-cols-2 gap-2.5">
								{(
									[
										["kimiLast24h", kimiUsage?.last24h],
										["kimiLast7d", kimiUsage?.last7d],
									] as const
								).map(([labelKey, window]) => (
									<StatTile key={labelKey} label={t(`dashboard.${labelKey}`)}>
										<div className="text-lg font-semibold text-th-text tabular-nums">
											{formatTokens(window?.totalTokens ?? 0)}
										</div>
										<div className="text-[11px] text-th-text-muted">
											{t("dashboard.kimiTurns", { count: window?.turns ?? 0 })}
										</div>
										{window?.costUsd !== undefined && (
											<div className="mt-1.5 pt-1.5 border-t border-white/[0.06]">
												<span className="text-sm font-semibold text-emerald-300 tabular-nums">
													{formatUsd(window.costUsd)}
												</span>
												<span className="ml-1 text-[10px] text-th-text-muted">
													{t("dashboard.kimiCostEstimated")}
												</span>
											</div>
										)}
									</StatTile>
								))}
							</div>
							{(kimiUsage?.models.length ?? 0) > 0 && (
								<div className="mt-3 space-y-1">
									<div className="text-[11px] text-th-text-muted">
										{t("dashboard.kimiModelBreakdown")}
									</div>
									{kimiUsage?.models.map((m) => (
										<div
											key={m.model}
											className="flex justify-between gap-2 text-xs text-th-text-secondary"
										>
											<span className="truncate" title={m.pricedAs}>
												{m.pricedAs ?? m.model}
											</span>
											<span className="shrink-0 tabular-nums">
												{formatTokens(m.totalTokens)}
												{m.costUsd !== undefined && (
													<span className="ml-2 text-emerald-300">
														{formatUsd(m.costUsd)}
													</span>
												)}
											</span>
										</div>
									))}
								</div>
							)}
						</Card>
						{kimiUsage?.daily && (
							<div className="md:col-span-2">
								<KimiDailyCostChart daily={kimiUsage.daily} />
							</div>
						)}
						{openRouterUsage && (
							<Card
								className="md:col-span-2"
								title={t("dashboard.openRouterSpend")}
								aside={
									<span className="text-[10px] text-th-text-muted shrink-0">
										{t("dashboard.openRouterActual")}
									</span>
								}
								footnote={t("dashboard.openRouterWindowNote")}
							>
								<div className="grid grid-cols-3 gap-2.5">
									{(
										[
											["openRouterToday", openRouterUsage.usageDailyUsd],
											["openRouterThisWeek", openRouterUsage.usageWeeklyUsd],
											["openRouterThisMonth", openRouterUsage.usageMonthlyUsd],
										] as const
									).map(([labelKey, usd]) => (
										<StatTile key={labelKey} label={t(`dashboard.${labelKey}`)}>
											<div className="text-lg font-semibold text-th-text tabular-nums">
												{usd === undefined ? "—" : formatUsd(usd)}
											</div>
										</StatTile>
									))}
								</div>
								{openRouterUsage.creditsRemainingUsd !== undefined && (
									<div className="mt-3 flex justify-between text-xs text-th-text-secondary">
										<span>{t("dashboard.openRouterBalance")}</span>
										<span className="tabular-nums">
											<span
												className={
													openRouterUsage.creditsRemainingUsd <= 0
														? "text-red-400 font-semibold"
														: "text-th-text"
												}
											>
												{formatUsd(openRouterUsage.creditsRemainingUsd)}
											</span>
											{openRouterUsage.creditsPurchasedUsd !== undefined && (
												<span className="ml-1 text-th-text-muted">
													/ {formatUsd(openRouterUsage.creditsPurchasedUsd)}
												</span>
											)}
										</span>
									</div>
								)}
								{openRouterUsage.limitRemainingUsd != null && (
									<div className="mt-1 flex justify-between text-xs text-th-text-secondary">
										<span>{t("dashboard.openRouterKeyLimitRemaining")}</span>
										<span className="tabular-nums">
											{formatUsd(openRouterUsage.limitRemainingUsd)}
										</span>
									</div>
								)}
							</Card>
						)}
					</div>
				) : effectiveTab === "opencode" ? (
					<div className={gridClass(compact)}>
						<Card
							className="md:col-span-2"
							title={t("dashboard.opencodeUsage")}
							footnote={t("dashboard.opencodeNoRateLimitInfo")}
						>
							<div className="grid grid-cols-2 gap-2.5">
								{(
									[
										["opencodeLast24h", opencodeUsage?.last24h],
										["opencodeLast7d", opencodeUsage?.last7d],
									] as const
								).map(([labelKey, window]) => (
									<StatTile key={labelKey} label={t(`dashboard.${labelKey}`)}>
										<div className="text-lg font-semibold text-th-text tabular-nums">
											{formatTokens(window?.totalTokens ?? 0)}
										</div>
										<div className="text-[11px] text-th-text-muted">
											{t("dashboard.opencodeTurns", { count: window?.turns ?? 0 })}
										</div>
										{window?.costUsd !== undefined && (
											<div className="mt-1.5 pt-1.5 border-t border-white/[0.06]">
												<span className="text-sm font-semibold text-emerald-300 tabular-nums">
													{formatUsd(window.costUsd)}
												</span>
												<span className="ml-1 text-[10px] text-th-text-muted">
													{t("dashboard.opencodeCostRecorded")}
												</span>
											</div>
										)}
									</StatTile>
								))}
							</div>
							{(opencodeUsage?.models.length ?? 0) > 0 && (
								<div className="mt-3 space-y-1">
									<div className="text-[11px] text-th-text-muted">
										{t("dashboard.opencodeModelBreakdown")}
									</div>
									{opencodeUsage?.models.map((m) => (
										<div
											key={m.model}
											className="flex justify-between gap-2 text-xs text-th-text-secondary"
										>
											<span className="truncate">{m.model}</span>
											<span className="shrink-0 tabular-nums">
												{formatTokens(m.totalTokens)}
												{m.costUsd !== undefined && (
													<span className="ml-2 text-emerald-300">
														{formatUsd(m.costUsd)}
													</span>
												)}
											</span>
										</div>
									))}
								</div>
							)}
						</Card>
					</div>
				) : effectiveTab === "codex" ? (
					<div className={gridClass(compact)}>
						<UsageLimits
							data={codexLimits || null}
							history={[]}
							title={t("dashboard.codexUsageLimits")}
							showMissingCycles
							badge={codexLimits?.planType}
							banner={
								codexLimits?.rateLimitExceeded
									? {
											message: t("dashboard.codexRateLimitExceeded"),
											tone: "danger",
										}
									: undefined
							}
							footnote={t("dashboard.codexOtherMetricsComingSoon")}
						/>
					</div>
				) : (
					<div className={gridClass(compact)}>
						<UsageLimits
							data={data?.usageLimits || null}
							status={data?.usageLimitsStatus}
							history={data?.usageHistory || []}
						/>
						<DailyUsageChart data={data?.dailyActivity || []} />
						<ModelUsageChart data={data?.modelUsage || []} />
						{data?.hourlyActivity &&
							Object.keys(data.hourlyActivity).length > 0 && (
								<HourlyHeatmap
									data={data.hourlyActivity}
									className="md:col-span-2"
								/>
							)}
					</div>
				)}
			</section>

			<section
				aria-labelledby="dashboard-server-status"
				className="mt-5 pt-4 border-t border-white/[0.06]"
			>
				<SectionHeading
					id="dashboard-server-status"
					icon={<Server className={ICON_CLASS} />}
				>
					{t("dashboard.serverStatus")}
				</SectionHeading>
				<div className={gridClass(compact)}>
					{/* Latency is on the local server's own card now — see
					    NetworkLatencyInline. A card of its own spent 116px on two
					    numbers, above a list of peers it did not describe. */}
					{/* Not in the agent section above: Groq is not an agent, it is this
					    server's own outbound spend on the glasses' voice input. */}
					{sttUsage && <SttUsageCard usage={sttUsage} />}
					{sortedPeers.map((peer) => (
						<PeerServerCard key={peer.id} peer={peer} />
					))}
				</div>
			</section>

			<section
				aria-labelledby="dashboard-settings"
				className="mt-5 pt-4 border-t border-white/[0.06]"
			>
				<SectionHeading
					id="dashboard-settings"
					icon={<SlidersHorizontal className={ICON_CLASS} />}
				>
					{t("dashboard.settings")}
				</SectionHeading>
				<div className="flex flex-wrap items-center gap-2 max-w-lg">
					{/* One switch for two screens: the list and the session view show
					    the steward together, because "see it through the steward" is a
					    single way of looking rather than a setting per screen. Absent
					    unless the server has a steward at all. */}
					{stewardAvailable && (
						<button
							type="button"
							onClick={() => setStewardView(!stewardView)}
							className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors ${
								stewardView
									? "bg-sky-500/15 text-sky-300 hover:bg-sky-500/20"
									: "bg-white/[0.04] text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
							}`}
							title={t("steward.viewToggle")}
						>
							<MessagesSquare className="h-3.5 w-3.5" />
							<span>{t("steward.viewToggle")}</span>
						</button>
					)}
					<button
						type="button"
						onClick={toggleTheme}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300 bg-white/[0.04] hover:bg-white/[0.06] rounded-md transition-colors"
						title={
							theme === "dark" ? t("appearance.light") : t("appearance.dark")
						}
					>
						{theme === "dark" ? (
							<Sun className="w-3.5 h-3.5" />
						) : (
							<Moon className="w-3.5 h-3.5" />
						)}
						<span>
							{theme === "dark" ? t("appearance.light") : t("appearance.dark")}
						</span>
					</button>
					<button
						type="button"
						onClick={() => {
							const newLang = i18n.language === "ja" ? "en" : "ja";
							i18n.changeLanguage(newLang);
						}}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-zinc-500 hover:text-zinc-300 bg-white/[0.04] hover:bg-white/[0.06] rounded-md transition-colors"
						title={
							i18n.language === "ja" ? "Switch to English" : "日本語に切替"
						}
					>
						<Globe className="w-3.5 h-3.5" />
						{i18n.language === "ja" ? "EN" : "JA"}
					</button>
					<button
						type="button"
						onClick={() => setShowResetConfirm(true)}
						className="text-[12px] text-zinc-600 hover:text-zinc-400 px-3 py-1.5 transition-colors"
					>
						{t("onboarding.resetTutorial")}
					</button>
					<button
						type="button"
						onClick={handleClearCache}
						disabled={cacheClearing}
						className="text-[12px] text-zinc-600 hover:text-red-400 px-3 py-1.5 transition-colors disabled:opacity-50"
					>
						{cacheClearing ? t("common.loading") : t("dashboard.clearCache")}
					</button>
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-2 max-w-lg">
					<span className="text-[12px] text-zinc-500">
						{t("appearance.uiScale")}
					</span>
					<fieldset
						className="inline-flex items-center rounded-md bg-white/[0.04] p-0.5 border-0"
						aria-label={t("appearance.uiScale")}
					>
						{uiScaleOptions.map((opt) => {
							const isActive = Math.abs(uiScale - opt) < 0.001;
							return (
								<button
									key={opt}
									type="button"
									onClick={() => setUiScale(opt)}
									aria-pressed={isActive}
									className={`px-2.5 py-1 text-[12px] rounded transition-colors ${
										isActive
											? "bg-white/[0.10] text-zinc-200"
											: "text-zinc-500 hover:text-zinc-300"
									}`}
								>
									{Math.round(opt * 100)}%
								</button>
							);
						})}
					</fieldset>
					{/* The chat's own size, beside the UI's. Two settings rather than
					    one because they answer different questions: the UI scale is how
					    big this device draws everything, and this is how big the text
					    being read is - a phone at arm's length wants the second larger
					    without the first following it. Reachable here because the pinch
					    that also sets it is a gesture nobody finds by looking. */}
					<span className="ml-3 text-[12px] text-zinc-500">
						{t("appearance.chatFontSize")}
					</span>
					<fieldset
						className="inline-flex items-center rounded-md bg-white/[0.04] p-0.5 border-0"
						aria-label={t("appearance.chatFontSize")}
					>
						<button
							type="button"
							onClick={() => changeChatFontSize(-1)}
							aria-label={t("appearance.chatFontSmaller")}
							className="px-2.5 py-1 text-[12px] rounded text-zinc-500 transition-colors hover:text-zinc-300"
						>
							−
						</button>
						<button
							type="button"
							onClick={resetChatFontSize}
							aria-label={t("appearance.chatFontReset")}
							className={`px-2 py-1 text-[12px] rounded transition-colors ${
								chatFontSize === CHAT_FONT_DEFAULT
									? "text-zinc-500"
									: "bg-white/[0.10] text-zinc-200"
							}`}
						>
							{chatFontSize}px
						</button>
						<button
							type="button"
							onClick={() => changeChatFontSize(1)}
							aria-label={t("appearance.chatFontLarger")}
							className="px-2.5 py-1 text-[12px] rounded text-zinc-500 transition-colors hover:text-zinc-300"
						>
							＋
						</button>
					</fieldset>
					{/* On the scale row's own line rather than under it: a version
					    string is not a setting, and a row of its own gave it the
					    weight of one.

					    Two numbers when they disagree, because this one said only the
					    server's - so a phone still running last release's bundle
					    displayed the number of the release it did not have, and read
					    as up to date. A fix shipped, checked from that phone, and
					    reported as not working is the shape that costs the most: the
					    page's own version is otherwise only in a console line, which
					    on a phone nobody can reach. */}
					{data?.version && (
						<span className="ml-auto shrink-0 text-[11px]">
							<span className="text-zinc-700">
								{IDENTITY.productName} v{data.version}
							</span>
							{__APP_VERSION__ !== data.version && (
								<span className="ml-1.5 text-amber-500/80">
									{t("appearance.pageVersion", "この画面 v{{version}}", {
										version: __APP_VERSION__,
									})}
								</span>
							)}
						</span>
					)}
				</div>
			</section>

			{/* Reset confirmation dialog */}
			{showResetConfirm && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)]">
					<div className="bg-th-surface rounded-md p-4 max-w-xs w-full mx-4 shadow-xl">
						<h3 className="text-sm font-medium text-th-text mb-2">
							{t("onboarding.resetTutorial")}
						</h3>
						<p className="text-xs text-th-text-secondary mb-4">
							{t("onboarding.resetConfirm")}
						</p>
						<div className="flex gap-2 justify-end">
							<button
								type="button"
								onClick={() => setShowResetConfirm(false)}
								className="px-3 py-1.5 text-xs bg-th-surface-active hover:bg-th-surface-active rounded text-th-text transition-colors"
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								onClick={handleResetOnboarding}
								className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded text-th-text transition-colors"
							>
								{t("common.confirm")}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
