import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	HerdrUpdateStatus,
	HrdleUpdateStatus,
	SystemMetrics,
	SystemMetricsSnapshot,
} from "../../../../shared/types";
import { IDENTITY } from "../../../../shared/identity";
import { useIsLightMode } from "../../hooks/useIsLightMode";
import { authFetch } from "../../services/api";
import { storageKey } from "../../utils/app-storage";

const API_BASE = import.meta.env.VITE_API_URL || "";
/** Shared by every server card: the choice is about the reading, not the host. */
const CHART_PREF_KEY = storageKey("server-charts-expanded");

// ─── Mini SVG chart ───
const CHART_WIDTH = 300;
const CHART_HEIGHT = 50;
const PADDING = { top: 4, right: 8, bottom: 12, left: 28 };
const INNER_W = CHART_WIDTH - PADDING.left - PADDING.right;
const INNER_H = CHART_HEIGHT - PADDING.top - PADDING.bottom;

function valueToY(value: number): number {
	return PADDING.top + INNER_H - (Math.min(value, 100) / 100) * INNER_H;
}

function buildPath(
	snapshots: SystemMetricsSnapshot[],
	getValue: (s: SystemMetricsSnapshot) => number,
) {
	if (snapshots.length === 0) return { linePath: "", areaPath: "" };
	const minTs = snapshots[0].timestamp;
	const maxTs = snapshots[snapshots.length - 1].timestamp;
	const range = maxTs - minTs || 1;
	const points = snapshots.map((s) => ({
		x: PADDING.left + ((s.timestamp - minTs) / range) * INNER_W,
		y: valueToY(getValue(s)),
	}));
	const linePath = points
		.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
		.join(" ");
	const baseline = valueToY(0);
	const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${baseline.toFixed(1)} L${points[0].x.toFixed(1)},${baseline.toFixed(1)} Z`;
	return { linePath, areaPath };
}

// ─── Inline sparkline ───
//
// The same series as MiniChart with everything explanatory removed: no axis,
// no gridlines, no fill. It sits on the metric's own row beside the number,
// where its job is the shape of the last few minutes and the number carries
// the value. Three of those rows replace three 50px charts that were mostly
// axis - and on a panel this narrow the axis was the part that did not fit.
const SPARK_W = 72;
const SPARK_H = 16;

function Sparkline({
	snapshots,
	getValue,
	lineColor,
}: {
	snapshots: SystemMetricsSnapshot[];
	getValue: (s: SystemMetricsSnapshot) => number;
	lineColor: string;
}) {
	const path = useMemo(() => {
		if (snapshots.length < 2) return "";
		const minTs = snapshots[0].timestamp;
		const range = snapshots[snapshots.length - 1].timestamp - minTs || 1;
		return snapshots
			.map((s, i) => {
				const x = ((s.timestamp - minTs) / range) * SPARK_W;
				const y = SPARK_H - (Math.min(getValue(s), 100) / 100) * (SPARK_H - 2) - 1;
				return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(" ");
	}, [snapshots, getValue]);

	if (!path) return <div style={{ width: SPARK_W, height: SPARK_H }} />;
	return (
		<svg
			aria-hidden="true"
			viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
			width={SPARK_W}
			height={SPARK_H}
			className="shrink-0 overflow-visible"
			preserveAspectRatio="none"
		>
			<path
				d={path}
				fill="none"
				stroke={lineColor}
				strokeWidth="1.25"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

/** One compact metric line: name, value, and the shape of its recent history. */
function MetricRow({
	label,
	value,
	valueClass,
	children,
}: {
	label: string;
	value: string;
	valueClass: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-2">
			<span className="text-[11px] text-zinc-500 w-[4.5rem] shrink-0">
				{label}
			</span>
			<span className={`text-[11px] tabular-nums shrink-0 ${valueClass}`}>
				{value}
			</span>
			<div className="flex-1 min-w-0 flex justify-end">{children}</div>
		</div>
	);
}

function MiniChart({
	snapshots,
	getValue,
	lineColor,
	gradientId,
	isLight,
}: {
	snapshots: SystemMetricsSnapshot[];
	getValue: (s: SystemMetricsSnapshot) => number;
	lineColor: string;
	gradientId: string;
	isLight: boolean;
}) {
	const { linePath, areaPath } = useMemo(
		() => buildPath(snapshots, getValue),
		[snapshots, getValue],
	);
	return (
		<svg
			aria-hidden="true"
			viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
			className="w-full"
			preserveAspectRatio="xMidYMid meet"
		>
			<defs>
				<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
					<stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
				</linearGradient>
			</defs>
			<rect
				x={PADDING.left}
				y={PADDING.top}
				width={INNER_W}
				height={INNER_H}
				fill={isLight ? "#ffffff" : "#1f2937"}
				rx="2"
			/>
			{[0, 50, 100].map((val) => (
				<g key={val}>
					<line
						x1={PADDING.left}
						y1={valueToY(val)}
						x2={PADDING.left + INNER_W}
						y2={valueToY(val)}
						stroke={isLight ? "#d1d5db" : "#374151"}
						strokeWidth="0.5"
					/>
					<text
						x={PADDING.left - 3}
						y={valueToY(val) + 3}
						textAnchor="end"
						fill="#6b7280"
						fontSize="7"
					>
						{val}%
					</text>
				</g>
			))}
			{areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
			{linePath && (
				<path
					d={linePath}
					fill="none"
					stroke={lineColor}
					strokeWidth="1.5"
					strokeLinejoin="round"
				/>
			)}
			{snapshots.length > 0 &&
				(() => {
					const last = snapshots[snapshots.length - 1];
					const minTs = snapshots[0].timestamp;
					const range = last.timestamp - minTs || 1;
					const cx =
						PADDING.left + ((last.timestamp - minTs) / range) * INNER_W;
					return (
						<circle
							cx={cx}
							cy={valueToY(getValue(last))}
							r="2.5"
							fill={lineColor}
							stroke={isLight ? "#fff" : "#111827"}
							strokeWidth="1"
						/>
					);
				})()}
			{snapshots.length >= 2 &&
				(() => {
					const fmt = (d: Date) =>
						`${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`;
					return (
						<>
							<text
								x={PADDING.left}
								y={CHART_HEIGHT - 1}
								textAnchor="start"
								fill="#6b7280"
								fontSize="6"
							>
								{fmt(new Date(snapshots[0].timestamp))}
							</text>
							<text
								x={PADDING.left + INNER_W}
								y={CHART_HEIGHT - 1}
								textAnchor="end"
								fill="#6b7280"
								fontSize="6"
							>
								{fmt(new Date(snapshots[snapshots.length - 1].timestamp))}
							</text>
						</>
					);
				})()}
		</svg>
	);
}

// ─── Progress bar ───
function ProgressBar({ percent, color }: { percent: number; color: string }) {
	return (
		<div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
			<div
				className={`h-full rounded-full ${color}`}
				style={{ width: `${Math.min(percent, 100)}%` }}
			/>
		</div>
	);
}

// ─── Helpers ───
function formatBytes(bytes: number): string {
	if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatSpeed(bps: number): string {
	if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
	if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} KB/s`;
	return `${bps.toFixed(0)} B/s`;
}

// ─── herdr version skew notice (#393) ───
/**
 * `herdr update` swaps the binary but leaves the running server on the old
 * version, and cchub spawns that binary to drive panes — so the skew shows up
 * as "the terminal won't connect". Applying costs every running command, so
 * the restart happens only when the user presses this button.
 */
function HerdrUpdateNotice({
	status,
	allowApply,
	onApplied,
}: {
	status: HerdrUpdateStatus;
	allowApply: boolean;
	onApplied?: () => void;
}) {
	const { t } = useTranslation();
	const [applying, setApplying] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const apply = useCallback(async () => {
		setApplying(true);
		setError(null);
		try {
			const res = await authFetch(`${API_BASE}/api/herdr/apply-update`, {
				method: "POST",
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			onApplied?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setApplying(false);
		}
	}, [onApplied]);

	// The button is offered only for the local server: it restarts *this*
	// host's herdr, and an unsupervised server can't be restarted at all.
	const canApply = allowApply && status.canApply;

	// Two different situations wear the same button. A newer release means a
	// stop/update/start; skew alone means only the running server is stale, and
	// saying "a new version is available" there would be a lie (#259, #260).
	const isNewRelease = status.updateAvailable === true;

	return (
		<div className="rounded-md border border-amber-500/30 bg-amber-500/[0.08] p-2 space-y-1.5">
			<div className="flex items-start gap-1.5">
				<AlertTriangle className="w-3 h-3 text-amber-400 mt-0.5 shrink-0" />
				<div className="min-w-0 space-y-0.5">
					<p className="text-[11px] font-medium text-amber-300">
						{isNewRelease
							? t("dashboard.herdrReleaseTitle", {
									version: status.latestVersion,
								})
							: t("dashboard.herdrUpdateTitle")}
					</p>
					{isNewRelease
						? status.binaryVersion && (
								<p className="text-[10px] text-amber-200/60 font-mono tabular-nums">
									{t("dashboard.herdrReleaseVersions", {
										installed: status.binaryVersion,
										latest: status.latestVersion,
									})}
								</p>
							)
						: status.serverVersion &&
							status.binaryVersion && (
								<p className="text-[10px] text-amber-200/60 font-mono tabular-nums">
									{t("dashboard.herdrUpdateVersions", {
										server: status.serverVersion,
										binary: status.binaryVersion,
									})}
								</p>
							)}
					<p className="text-[10px] text-amber-200/70 leading-snug">
						{t("dashboard.herdrUpdateCost")}
					</p>
				</div>
			</div>
			{canApply ? (
				<button
					type="button"
					onClick={apply}
					disabled={applying}
					className="w-full text-[11px] font-medium px-2 py-1 rounded bg-amber-500/20 text-amber-200 border border-amber-500/30 hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				>
					{applying
						? t("dashboard.herdrUpdateApplying")
						: isNewRelease
							? t("dashboard.herdrUpdateApply")
							: t("dashboard.herdrRestartApply")}
				</button>
			) : (
				allowApply && (
					<p className="text-[10px] text-amber-200/50 leading-snug">
						{t("dashboard.herdrUpdateManualHint")}
					</p>
				)
			)}
			{error && (
				<p className="text-[10px] text-red-400 leading-snug break-words">
					{t("dashboard.herdrUpdateFailed", { error })}
				</p>
			)}
		</div>
	);
}

// ─── Versions ───
/**
 * What this machine is running, and whether it is current — for both halves of
 * the stack. Shown always, not only when something is wrong: "am I on the
 * latest?" is a question people ask before anything is wrong, and the warning
 * above only ever appears once the answer is already no.
 */
function VersionRow({
	name,
	installed,
	latest,
	updateAvailable,
	detail,
}: {
	name: string;
	installed?: string;
	latest?: string;
	updateAvailable?: boolean;
	/** Extra qualifier shown after the version, e.g. a stale server behind a newer binary. */
	detail?: string;
}) {
	const { t } = useTranslation();
	if (!installed) return null;
	return (
		<div className="flex items-baseline gap-2 text-[11px]">
			<span className="text-th-text-muted shrink-0">{name}</span>
			<span className="font-mono tabular-nums text-th-text truncate">
				{installed}
				{detail && (
					<span className="text-th-text-muted"> {detail}</span>
				)}
			</span>
			<span className="ml-auto shrink-0 text-[10px]">
				{updateAvailable === true ? (
					<span className="text-amber-400">
						{t("dashboard.versionOutdated", { latest })}
					</span>
				) : updateAvailable === false ? (
					<span className="text-emerald-500/80">
						{t("dashboard.versionCurrent")}
					</span>
				) : (
					<span className="text-th-text-muted/60">
						{t("dashboard.versionUnknown")}
					</span>
				)}
			</span>
		</div>
	);
}

// ─── Main component ───
interface ServerInfoProps {
	systemMetrics?: SystemMetrics;
	diskUsage?: {
		total: number;
		used: number;
		available: number;
		mountpoint: string;
	};
	/** Hide the throughput chart (it tracks this browser's WS bytes, not the peer's). */
	hideThroughput?: boolean;
	/** herdr binary-vs-server skew, and whether a newer release exists (#393, #259). */
	herdrUpdate?: HerdrUpdateStatus;
	/** This server's own version and whether it is the published one (#259). */
	hrdleUpdate?: HrdleUpdateStatus;
	/** Offer the apply button — local server only; the endpoint restarts this host's herdr. */
	allowHerdrApply?: boolean;
	/** Re-poll after an apply so the warning clears once the server is current. */
	onHerdrApplied?: () => void;
}

// Throughput history (kept in module scope so it persists across re-renders)
const MAX_THROUGHPUT_HISTORY = 60;
const throughputHistory: { timestamp: number; value: number }[] = [];

function buildThroughputPath(
	data: { timestamp: number; value: number }[],
	maxVal: number,
) {
	if (data.length < 2) return { linePath: "", areaPath: "" };
	const minTs = data[0].timestamp;
	const maxTs = data[data.length - 1].timestamp;
	const range = maxTs - minTs || 1;
	const cap = maxVal || 1;
	const points = data.map((d) => ({
		x: PADDING.left + ((d.timestamp - minTs) / range) * INNER_W,
		y: PADDING.top + INNER_H - (Math.min(d.value, cap) / cap) * INNER_H,
	}));
	const linePath = points
		.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
		.join(" ");
	const baseline = PADDING.top + INNER_H;
	const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${baseline.toFixed(1)} L${points[0].x.toFixed(1)},${baseline.toFixed(1)} Z`;
	return { linePath, areaPath };
}

export function ServerInfo({
	systemMetrics,
	diskUsage,
	hideThroughput = false,
	herdrUpdate,
	hrdleUpdate,
	allowHerdrApply = false,
	onHerdrApplied,
}: ServerInfoProps) {
	const { t } = useTranslation();
	const isLight = useIsLightMode();

	const [throughput, setThroughput] = useState(0);
	const [, forceUpdate] = useState(0);
	useEffect(() => {
		if (hideThroughput) return;
		const interval = setInterval(() => {
			const val = window.__cchub_ws_bytes_per_sec || 0;
			setThroughput(val);
			throughputHistory.push({ timestamp: Date.now(), value: val });
			if (throughputHistory.length > MAX_THROUGHPUT_HISTORY) {
				throughputHistory.splice(
					0,
					throughputHistory.length - MAX_THROUGHPUT_HISTORY,
				);
			}
			forceUpdate((n) => n + 1);
		}, 1000);
		return () => clearInterval(interval);
	}, [hideThroughput]);

	// Compact by default. The full charts are still a tap away, and the choice
	// outlives the panel - it unmounts when closed, so component state alone
	// would put the charts away again every time it was reopened.
	const [expanded, setExpanded] = useState(
		() => localStorage.getItem(CHART_PREF_KEY) === "true",
	);
	const toggleExpanded = useCallback(() => {
		setExpanded((was) => {
			localStorage.setItem(CHART_PREF_KEY, String(!was));
			return !was;
		});
	}, []);

	const getCpu = useMemo(() => (s: SystemMetricsSnapshot) => s.cpuPercent, []);
	const getMem = useMemo(
		() => (s: SystemMetricsSnapshot) => s.memUsedPercent,
		[],
	);

	const cur = systemMetrics?.current;
	const history = systemMetrics?.history || [];
	const diskPercent = diskUsage
		? Math.round((diskUsage.used / diskUsage.total) * 100)
		: 0;
	const swapPercent =
		cur && cur.swapTotalMB > 0 ? (cur.swapUsedMB / cur.swapTotalMB) * 100 : 0;

	// The server's name and client count live on the card's own title row
	// (`PeerServerCard`) — drawing them again here printed "Local" twice, once
	// muted and once bold, directly above each other.
	return (
		<div className="space-y-3">
			{(herdrUpdate?.restartNeeded || herdrUpdate?.updateAvailable) && (
				<HerdrUpdateNotice
					status={herdrUpdate}
					allowApply={allowHerdrApply}
					onApplied={onHerdrApplied}
				/>
			)}

			{(hrdleUpdate || herdrUpdate?.binaryVersion) && (
				<div className="space-y-1">
					<VersionRow
						name={IDENTITY.productName}
						installed={hrdleUpdate?.currentVersion}
						latest={hrdleUpdate?.latestVersion}
						updateAvailable={hrdleUpdate?.updateAvailable}
					/>
					<VersionRow
						name="herdr"
						installed={herdrUpdate?.binaryVersion}
						latest={herdrUpdate?.latestVersion}
						updateAvailable={herdrUpdate?.updateAvailable}
						// Only worth printing when it disagrees with the binary; equal
						// versions are the normal case and would just be noise.
						detail={
							herdrUpdate?.restartNeeded && herdrUpdate?.serverVersion
								? t("dashboard.herdrServerRunning", {
										version: herdrUpdate.serverVersion,
									})
								: undefined
						}
					/>
				</div>
			)}

			{/* One line per metric. The full charts are behind the toggle below. */}
			{cur && !expanded && (
				<div className="space-y-1.5">
					<MetricRow
						label="CPU"
						value={`${cur.cpuPercent.toFixed(1)}%`}
						valueClass="text-blue-400"
					>
						<Sparkline
							snapshots={history}
							getValue={getCpu}
							lineColor="#3b82f6"
						/>
					</MetricRow>
					<MetricRow
						label="Memory"
						value={`${(cur.memUsedMB / 1024).toFixed(1)} / ${(cur.memTotalMB / 1024).toFixed(1)} GB`}
						valueClass="text-purple-400"
					>
						<Sparkline
							snapshots={history}
							getValue={getMem}
							lineColor="#a855f7"
						/>
					</MetricRow>
					{!hideThroughput && (
						<MetricRow
							label="Throughput"
							value={formatSpeed(throughput)}
							valueClass="text-teal-400"
						/>
					)}
				</div>
			)}

			{/* Charts: CPU, Memory, Throughput */}
			{cur && expanded && (
				<div className="space-y-2.5">
					{/* CPU */}
					<div>
						<div className="flex items-baseline justify-between mb-0.5">
							<span className="text-[11px] text-zinc-500">CPU</span>
							<span className="text-[12px] font-medium text-blue-400 tabular-nums">
								{cur.cpuPercent.toFixed(1)}%
							</span>
						</div>
						<MiniChart
							snapshots={history}
							getValue={getCpu}
							lineColor="#3b82f6"
							gradientId="srv-cpu"
							isLight={isLight}
						/>
					</div>

					{/* Memory */}
					<div>
						<div className="flex items-baseline justify-between mb-0.5">
							<span className="text-[11px] text-zinc-500">Memory</span>
							<span className="text-[12px] font-medium text-purple-400 tabular-nums">
								{(cur.memUsedMB / 1024).toFixed(1)} /{" "}
								{(cur.memTotalMB / 1024).toFixed(1)} GB
							</span>
						</div>
						<MiniChart
							snapshots={history}
							getValue={getMem}
							lineColor="#a855f7"
							gradientId="srv-mem"
							isLight={isLight}
						/>
					</div>

					{/* Throughput (local-only — tracks this browser's WS bytes) */}
					{!hideThroughput && (
					<div>
						<div className="flex items-baseline justify-between mb-0.5">
							<span className="text-[11px] text-zinc-500">Throughput</span>
							<span className="text-[12px] font-medium text-teal-400 tabular-nums">
								{formatSpeed(throughput)}
							</span>
						</div>
						{throughputHistory.length >= 2 ? (
							(() => {
								const maxVal = Math.max(
									...throughputHistory.map((d) => d.value),
									1024,
								);
								const { linePath, areaPath } = buildThroughputPath(
									throughputHistory,
									maxVal,
								);
								return (
									<svg
										aria-hidden="true"
										viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
										className="w-full"
										preserveAspectRatio="xMidYMid meet"
									>
										<defs>
											<linearGradient id="srv-tp" x1="0" y1="0" x2="0" y2="1">
												<stop
													offset="0%"
													stopColor="#14b8a6"
													stopOpacity="0.25"
												/>
												<stop
													offset="100%"
													stopColor="#14b8a6"
													stopOpacity="0.02"
												/>
											</linearGradient>
										</defs>
										<rect
											x={PADDING.left}
											y={PADDING.top}
											width={INNER_W}
											height={INNER_H}
											fill={isLight ? "#ffffff" : "#1f2937"}
											rx="2"
										/>
										{areaPath && <path d={areaPath} fill="url(#srv-tp)" />}
										{linePath && (
											<path
												d={linePath}
												fill="none"
												stroke="#14b8a6"
												strokeWidth="1.5"
												strokeLinejoin="round"
											/>
										)}
									</svg>
								);
							})()
						) : (
							<div className="h-[17px] flex items-center">
								<span className="text-[10px] text-zinc-600">
									Collecting data...
								</span>
							</div>
						)}
					</div>
					)}
				</div>
			)}

			{/* Swap + Disk. The bar rides on the row rather than under it: these
			    are ratios of a fixed total, so the number carries the fact and the
			    bar only has to show how full it is. */}
			<div className="space-y-1.5 pt-2 border-t border-white/[0.04]">
				{cur && cur.swapTotalMB > 0 && (
					<MetricRow
						label="Swap"
						value={`${(cur.swapUsedMB / 1024).toFixed(1)} / ${(cur.swapTotalMB / 1024).toFixed(1)} GB`}
						valueClass="text-amber-400"
					>
						<div className="w-[72px] shrink-0">
							<ProgressBar percent={swapPercent} color="bg-amber-500" />
						</div>
					</MetricRow>
				)}
				{diskUsage && (
					<MetricRow
						label="Disk"
						value={`${formatBytes(diskUsage.used)} / ${formatBytes(diskUsage.total)}`}
						valueClass={
							diskPercent > 90
								? "text-red-400"
								: diskPercent > 75
									? "text-amber-400"
									: "text-emerald-400"
						}
					>
						<div className="w-[72px] shrink-0">
							<ProgressBar
								percent={diskPercent}
								color={
									diskPercent > 90
										? "bg-red-500"
										: diskPercent > 75
											? "bg-amber-500"
											: "bg-emerald-500"
								}
							/>
						</div>
					</MetricRow>
				)}
			</div>

			{/* Footer: load average, and the way back to the full charts */}
			<div className="flex items-center justify-between gap-2 text-[10px] text-th-text-muted">
				<span className="truncate">
					{systemMetrics?.loadAvg
						? `Load: ${systemMetrics.loadAvg.map((v) => v.toFixed(2)).join(" / ")} (${systemMetrics.cpuCount} cores)`
						: ""}
				</span>
				{cur && (
					<button
						type="button"
						onClick={toggleExpanded}
						className="shrink-0 text-[10px] text-th-text-muted hover:text-th-text-secondary underline underline-offset-2 decoration-dotted"
						aria-expanded={expanded}
					>
						{expanded ? t("dashboard.chartsHide") : t("dashboard.chartsShow")}
					</button>
				)}
			</div>
		</div>
	);
}
