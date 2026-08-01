import { useTranslation } from "react-i18next";
import type { ModelUsage } from "../../../../shared/types";
import { formatTokens } from "../../utils/format";
import { Card } from "./Card";

interface ModelUsageChartProps {
	data: ModelUsage[];
}

// Shades per model family; versions within a family cycle through shades
const FAMILY_SHADES: Record<string, string[]> = {
	opus: ["bg-fuchsia-500", "bg-purple-500", "bg-violet-400", "bg-indigo-500"],
	sonnet: ["bg-blue-500", "bg-sky-400", "bg-cyan-500"],
	haiku: ["bg-emerald-500", "bg-teal-400", "bg-green-500"],
	fable: ["bg-amber-500", "bg-orange-400"],
	other: ["bg-gray-500", "bg-slate-400", "bg-zinc-400"],
};

function buildColorMap(models: string[]): Map<string, string> {
	const familyCounts: Record<string, number> = {};
	const map = new Map<string, string>();
	for (const model of models) {
		const family =
			Object.keys(FAMILY_SHADES).find((f) =>
				model.toLowerCase().includes(f),
			) ?? "other";
		const shades = FAMILY_SHADES[family];
		const index = familyCounts[family] ?? 0;
		familyCounts[family] = index + 1;
		map.set(model, shades[index % shades.length]);
	}
	return map;
}

export function ModelUsageChart({ data }: ModelUsageChartProps) {
	const { t } = useTranslation();

	if (data.length === 0) {
		return (
			<Card title={t("dashboard.modelUsageWindow")}>
				<div className="text-th-text-muted text-xs">
					{t("dashboard.noData")}
				</div>
			</Card>
		);
	}

	const modelTotal = (m: ModelUsage) =>
		m.totalTokensIn + m.totalTokensOut + m.totalCacheRead;

	const sorted = [...data].sort((a, b) => modelTotal(b) - modelTotal(a));
	const total = sorted.reduce((sum, m) => sum + modelTotal(m), 0);
	const colorMap = buildColorMap(sorted.map((m) => m.model));

	return (
		<Card
			title={t("dashboard.modelUsageWindow")}
			aside={
				<span className="text-[11px] text-th-text-muted tabular-nums shrink-0">
					{formatTokens(total)}
				</span>
			}
		>
			{/* Bar chart */}
			<div className="h-3 bg-th-surface-hover rounded-full overflow-hidden flex">
				{sorted.map((model) => {
					const pct = (modelTotal(model) / total) * 100;
					if (pct < 1) return null;
					return (
						<div
							key={model.model}
							className={`${colorMap.get(model.model)} h-full`}
							style={{ width: `${pct}%` }}
							title={`${model.model}: ${formatTokens(modelTotal(model))} tokens (${pct.toFixed(1)}%)`}
						/>
					);
				})}
			</div>

			{/* Legend */}
			{/* The bar already carries the share, so the legend carries the number it
			    cannot — a percentage next to it was the same fact twice. */}
			<div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
				{sorted.map((model) => (
					<div
						key={model.model}
						className="flex items-center gap-1 whitespace-nowrap"
						title={`${model.model}: in ${formatTokens(model.totalTokensIn)} / out ${formatTokens(model.totalTokensOut)} / cache ${formatTokens(model.totalCacheRead)}`}
					>
						<span
							className={`w-1.5 h-1.5 rounded-full shrink-0 ${colorMap.get(model.model)}`}
						/>
						<span className="text-th-text-secondary">{model.model}</span>
						<span className="text-th-text-muted tabular-nums">
							{formatTokens(modelTotal(model))}
						</span>
					</div>
				))}
			</div>
		</Card>
	);
}
