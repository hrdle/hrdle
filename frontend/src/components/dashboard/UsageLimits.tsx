import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
	UsageCycleInfo,
	UsageLimitsStatus,
	UsageScopedLimit,
	UsageSnapshot,
} from "../../../../shared/types";
import { Card, CardTitle } from "./Card";
import { type UsageChartOverlay, UsageChart } from "./UsageChart";

interface UsageLimitsData {
	fiveHour?: UsageCycleInfo;
	sevenDay?: UsageCycleInfo;
	scopedLimits?: UsageScopedLimit[];
}

// Hues chosen to stay distinct from the cycle line, which is already green /
// yellow / red depending on status.
const OVERLAY_COLORS = ["#a855f7", "#06b6d4", "#f472b6", "#facc15"];

function toOverlays(
	scopedLimits: UsageScopedLimit[] | undefined,
	group: "session" | "weekly",
): UsageChartOverlay[] {
	if (!scopedLimits?.length) return [];
	// Index the palette within the whole set rather than per group, so a model
	// keeps one colour across both charts.
	return scopedLimits.flatMap((limit, i) =>
		limit.group === group
			? [
					{
						key: limit.key,
						name: limit.name,
						utilization: limit.utilization,
						isActive: limit.isActive,
						severity: limit.severity,
						color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
					},
				]
			: [],
	);
}

interface UsageLimitsProps {
	data: UsageLimitsData | null;
	status?: UsageLimitsStatus;
	history: UsageSnapshot[];
	title?: string;
	/** Render a placeholder for cycles that are absent from `data` (e.g. Codex free plan has no 5h). */
	showMissingCycles?: boolean;
	/** Small badge shown next to the title (e.g. plan name). */
	badge?: string;
	/** Optional banner shown above the cycles, e.g. "rate limit exceeded". */
	banner?: { message: string; tone?: "info" | "warning" | "danger" };
	/** Muted line under the cycles, for what this agent's data cannot show. */
	footnote?: ReactNode;
}

function formatTimeUntil(iso: string): string {
	const ms = new Date(iso).getTime() - Date.now();
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${seconds}s`;
}

function ErrorMessage({ status }: { status: UsageLimitsStatus }) {
	const { t } = useTranslation();
	if (!status.errorReason) return null;

	const messageKey: Record<
		NonNullable<UsageLimitsStatus["errorReason"]>,
		string
	> = {
		"rate-limited": "dashboard.usageErrorRateLimited",
		"no-credentials": "dashboard.usageErrorNoCredentials",
		unauthorized: "dashboard.usageErrorUnauthorized",
		"fetch-failed": "dashboard.usageErrorFetchFailed",
		unknown: "dashboard.usageErrorUnknown",
	};

	const message = t(messageKey[status.errorReason]);
	const isRateLimited = status.errorReason === "rate-limited";

	return (
		<div className="text-[11px] text-amber-400/90 mb-2 leading-relaxed">
			<div>{message}</div>
			{isRateLimited && (
				<div className="text-th-text-muted mt-0.5">
					{t("dashboard.usageErrorRateLimitedDetail")}
					{status.rateLimitedUntil && (
						<span>
							{" "}
							·{" "}
							{t("dashboard.usageRetryIn", {
								time: formatTimeUntil(status.rateLimitedUntil),
							})}
						</span>
					)}
				</div>
			)}
		</div>
	);
}

// Generate translated status message based on status
function getStatusMessage(
	t: (key: string, options?: Record<string, unknown>) => string,
	status: "safe" | "warning" | "danger" | "exceeded" | undefined,
	timeRemaining: string,
	estimatedHitTime?: string,
): string {
	switch (status) {
		case "exceeded":
			return t("dashboard.statusExceeded");
		case "danger":
			return t("dashboard.statusDanger", {
				time: estimatedHitTime || timeRemaining,
				resetTime: timeRemaining,
			});
		case "warning":
			return t("dashboard.statusWarning", { time: timeRemaining });
		default:
			// For 'safe' status, check utilization to decide between safe and normal
			return t("dashboard.statusSafe", { time: timeRemaining });
	}
}

function MissingCyclePlaceholder({
	label,
	message,
}: {
	label: string;
	message: string;
}) {
	return (
		<div className="mb-3">
			<div className="flex justify-between text-xs mb-1">
				<span className="text-th-text-secondary">{label}</span>
				<span className="text-th-text-muted">—</span>
			</div>
			<div className="text-[10px] text-th-text-muted">{message}</div>
		</div>
	);
}

function Banner({
	banner,
}: {
	banner: NonNullable<UsageLimitsProps["banner"]>;
}) {
	const toneClass =
		banner.tone === "danger"
			? "border-red-500/40 bg-red-500/10 text-red-300"
			: banner.tone === "warning"
				? "border-amber-500/40 bg-amber-500/10 text-amber-300"
				: "border-blue-500/40 bg-blue-500/10 text-blue-300";
	return (
		<div className={`text-[11px] mb-2 px-2 py-1.5 rounded border ${toneClass}`}>
			{banner.message}
		</div>
	);
}

export function UsageLimits({
	data,
	status,
	history,
	title,
	showMissingCycles = false,
	badge,
	banner,
	footnote,
}: UsageLimitsProps) {
	const { t } = useTranslation();
	const heading = title ?? t("dashboard.usageLimits");
	const headingNode = (
		<div className="flex items-center gap-2 min-w-0">
			<CardTitle>{heading}</CardTitle>
			{badge && (
				<span className="text-[10px] text-th-text-muted uppercase tracking-wide px-1.5 py-0.5 bg-white/[0.06] rounded shrink-0">
					{badge}
				</span>
			)}
		</div>
	);

	if (!data || (!data.fiveHour && !data.sevenDay)) {
		return (
			<Card title={headingNode} footnote={footnote}>
				{status?.errorReason ? (
					<ErrorMessage status={status} />
				) : (
					<div className="text-th-text-muted text-xs">
						{t("dashboard.usageDataUnavailable")}
					</div>
				)}
			</Card>
		);
	}

	const missingMessage = t("dashboard.cycleNotInPlan");

	const fiveHourNode = data.fiveHour ? (
		<UsageChart
			label={t("dashboard.fiveHourCycle")}
			field="fiveHour"
			snapshots={history}
			currentUtilization={data.fiveHour.utilization}
			resetsAt={data.fiveHour.resetsAt}
			status={data.fiveHour.status || "safe"}
			statusMessage={getStatusMessage(
				t,
				data.fiveHour.status,
				data.fiveHour.timeRemaining,
				data.fiveHour.estimatedHitTime,
			)}
			overlays={toOverlays(data.scopedLimits, "session")}
		/>
	) : showMissingCycles ? (
		<MissingCyclePlaceholder
			label={t("dashboard.fiveHourCycle")}
			message={missingMessage}
		/>
	) : null;

	const sevenDayNode = data.sevenDay ? (
		<UsageChart
			label={t("dashboard.sevenDayCycle")}
			field="sevenDay"
			snapshots={history}
			currentUtilization={data.sevenDay.utilization}
			resetsAt={data.sevenDay.resetsAt}
			status={data.sevenDay.status || "safe"}
			statusMessage={getStatusMessage(
				t,
				data.sevenDay.status,
				data.sevenDay.timeRemaining,
				data.sevenDay.estimatedHitTime,
			)}
			overlays={toOverlays(data.scopedLimits, "weekly")}
		/>
	) : showMissingCycles ? (
		<MissingCyclePlaceholder
			label={t("dashboard.sevenDayCycle")}
			message={missingMessage}
		/>
	) : null;

	// Side by side once the card itself is wide enough — a container query, not a
	// viewport one, because the same card also renders in the narrow side panel.
	// The charts are viewBox SVGs, so half the width costs nothing but pixels.
	const sideBySide = !!fiveHourNode && !!sevenDayNode;

	return (
		<Card
			title={headingNode}
			aside={
				status?.isStale ? (
					<span className="text-[10px] text-th-text-muted shrink-0">
						{t("dashboard.usageStaleData")}
					</span>
				) : undefined
			}
			footnote={footnote}
		>
			{status?.errorReason && <ErrorMessage status={status} />}
			{banner && <Banner banner={banner} />}

			<div className={sideBySide ? "@container" : undefined}>
				<div
					className={
						sideBySide
							? "grid gap-x-4 gap-y-3 @lg:grid-cols-2 [&>*]:mb-0 items-start"
							: undefined
					}
				>
					{fiveHourNode}
					{sevenDayNode}
				</div>
			</div>
		</Card>
	);
}
