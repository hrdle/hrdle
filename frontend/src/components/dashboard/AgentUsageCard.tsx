import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentUsageSummary } from "../../../../shared/types";
import { formatTokens, formatUsd } from "../../utils/format";
import { Card, StatTile } from "./Card";

/**
 * Token totals for an agent with no rate-limit windows to show: the two
 * rolling windows and the per-model breakdown. `costLabel` says whose figure
 * the cost is (our estimate, or what the agent recorded), because the
 * dashboard shows both kinds side by side.
 */
export function AgentUsageCard({
	title,
	footnote,
	usage,
	costLabel,
	aside,
}: {
	title: string;
	footnote: string;
	usage: AgentUsageSummary | null | undefined;
	costLabel?: string;
	aside?: ReactNode;
}) {
	const { t } = useTranslation();
	const windows = [
		["usageLast24h", usage?.last24h],
		["usageLast7d", usage?.last7d],
	] as const;
	return (
		<Card className="md:col-span-2" title={title} aside={aside} footnote={footnote}>
			<div className="grid grid-cols-2 gap-2.5">
				{windows.map(([labelKey, window]) => (
					<StatTile key={labelKey} label={t(`dashboard.${labelKey}`)}>
						<div className="text-lg font-semibold text-th-text tabular-nums">
							{formatTokens(window?.totalTokens ?? 0)}
						</div>
						<div className="text-[11px] text-th-text-muted">
							{t("dashboard.usageTurns", { count: window?.turns ?? 0 })}
						</div>
						{window?.costUsd !== undefined && (
							<div className="mt-1.5 pt-1.5 border-t border-white/[0.06]">
								<span className="text-sm font-semibold text-emerald-300 tabular-nums">
									{formatUsd(window.costUsd)}
								</span>
								{costLabel && (
									<span className="ml-1 text-[10px] text-th-text-muted">{costLabel}</span>
								)}
							</div>
						)}
					</StatTile>
				))}
			</div>
			{(usage?.models.length ?? 0) > 0 && (
				<div className="mt-3 space-y-1">
					<div className="text-[11px] text-th-text-muted">
						{t("dashboard.usageModelBreakdown")}
					</div>
					{usage?.models.map((m) => (
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
									<span className="ml-2 text-emerald-300">{formatUsd(m.costUsd)}</span>
								)}
							</span>
						</div>
					))}
				</div>
			)}
		</Card>
	);
}
