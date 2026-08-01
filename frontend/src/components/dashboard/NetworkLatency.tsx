import { useTranslation } from "react-i18next";
import { useNetworkLatency } from "../../hooks/useNetworkLatency";
import type { LatencyDataPoint } from "../../services/latency-store";
import { Card } from "./Card";

function getLatencyColor(value: number): string {
	if (value < 50) return "text-green-400";
	if (value < 150) return "text-yellow-400";
	return "text-red-400";
}

function getDotColor(value: number | null): string {
	if (value === null) return "bg-th-surface-active";
	if (value < 50) return "bg-green-500";
	if (value < 150) return "bg-yellow-500";
	return "bg-red-500";
}

function getBarColor(value: number): string {
	if (value < 50) return "bg-green-500";
	if (value < 150) return "bg-yellow-500";
	return "bg-red-500";
}

function Sparkline({ data }: { data: LatencyDataPoint[] }) {
	if (data.length === 0) return null;

	const maxVal = Math.max(...data.map((d) => d.value), 1);

	return (
		<div className="flex items-end gap-px h-4 flex-1 min-w-0">
			{data.map((point, i) => {
				const height = Math.max(2, (point.value / maxVal) * 16);
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: chart bars are a rolling time window keyed by position
						key={i}
						className={`w-[3px] shrink-0 rounded-sm ${getBarColor(point.value)}`}
						style={{
							height: `${height}px`,
							opacity: 0.4 + (i / data.length) * 0.6,
						}}
					/>
				);
			})}
		</div>
	);
}

interface LatencyRowProps {
	label: string;
	value: number | null;
	history: LatencyDataPoint[];
	naText: string;
	stale?: boolean;
}

function LatencyRow({ label, value, history, naText, stale }: LatencyRowProps) {
	const valueColor =
		value !== null
			? stale
				? "text-th-text-muted"
				: getLatencyColor(value)
			: "text-th-text-muted";

	return (
		<div className={`flex items-center gap-2 ${stale ? "opacity-60" : ""}`}>
			<div
				className={`w-1.5 h-1.5 rounded-full shrink-0 ${stale ? "bg-th-surface-active" : getDotColor(value)}`}
			/>
			<span className="text-[11px] text-th-text-secondary w-16 shrink-0">
				{label}
			</span>
			<span
				className={`text-[11px] w-12 shrink-0 text-right tabular-nums ${valueColor}`}
			>
				{value !== null ? `${value}ms` : naText}
			</span>
			<Sparkline data={history} />
		</div>
	);
}

export function NetworkLatency({ className = "" }: { className?: string }) {
	const { t } = useTranslation();
	const { wsLatency, apiLatency, wsHistory, apiHistory, wsConnected } =
		useNetworkLatency();

	return (
		<Card title={t("dashboard.networkLatency")} className={className}>
			<div className="space-y-1.5">
				<LatencyRow
					label={t("dashboard.websocket")}
					value={wsLatency}
					history={wsHistory}
					naText={t("dashboard.latencyNA")}
					stale={!wsConnected && wsLatency !== null}
				/>
				<LatencyRow
					label={t("dashboard.api")}
					value={apiLatency}
					history={apiHistory}
					naText={t("dashboard.latencyNA")}
				/>
			</div>
		</Card>
	);
}
