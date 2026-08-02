import { useTranslation } from "react-i18next";
import type { KimiUsageDay } from "../../../../shared/types";
import { formatTokens, formatUsd } from "../../utils/format";
import { Card } from "./Card";

interface KimiDailyCostChartProps {
	daily: KimiUsageDay[];
}

const BAR_HEIGHT_PX = 64;

/**
 * What each of the last seven days cost, and today's figure on the title row.
 *
 * The rolling windows next to this cannot answer "what has today cost me":
 * `last24h` read at 10:00 is mostly yesterday. So the buckets are local
 * calendar days (see `KimiUsageDay`), and today is the last bar.
 *
 * Cost only — never cost and tokens on one plot. They share no scale, and the
 * second axis it would take is the one thing a chart may not have. Tokens ride
 * along in each bar's tooltip, where they explain a bar rather than compete
 * with it.
 */
export function KimiDailyCostChart({ daily }: KimiDailyCostChartProps) {
	const { t, i18n } = useTranslation();
	const locale = i18n.language === "ja" ? "ja" : "en";

	// Nothing in the window could be priced: this card is about money, so it
	// has nothing to say. The tokens are on the usage card either way.
	if (!daily.some((d) => d.costUsd !== undefined && d.costUsd > 0)) return null;

	const maxCost = Math.max(...daily.map((d) => d.costUsd ?? 0), 0.0001);
	const today = daily[daily.length - 1];
	const total = daily.reduce((sum, d) => sum + (d.costUsd ?? 0), 0);

	return (
		<Card
			title={t("dashboard.kimiDailyCost")}
			aside={
				<span className="text-[11px] text-th-text-muted shrink-0">
					{t("dashboard.today")}{" "}
					<span className="text-emerald-300 tabular-nums font-medium">
						{today?.costUsd === undefined ? "—" : formatUsd(today.costUsd)}
					</span>
				</span>
			}
			footnote={t("dashboard.kimiDailyCostNote", {
				total: formatUsd(total),
			})}
		>
			<div
				className="flex items-end gap-1"
				style={{ height: `${BAR_HEIGHT_PX}px` }}
			>
				{daily.map((day, i) => {
					const isToday = i === daily.length - 1;
					const unknown = day.costUsd === undefined;
					const heightPx = Math.round(((day.costUsd ?? 0) / maxCost) * BAR_HEIGHT_PX);
					const label = unknown
						? t("dashboard.kimiDailyCostUnknown", { date: day.date })
						: `${day.date}: ${formatUsd(day.costUsd ?? 0)} · ${formatTokens(day.totalTokens)} · ${t("dashboard.kimiTurns", { count: day.turns })}`;
					return (
						<div
							key={day.date}
							className="flex-1 flex flex-col items-center justify-end h-full"
						>
							<div
								className={`w-full rounded-t transition-colors ${
									isToday ? "bg-emerald-400" : "bg-emerald-500/50"
								}`}
								style={{
									height: `${heightPx}px`,
									// A day that cost something must never round away to
									// nothing - "cheap" and "no usage" are different answers.
									minHeight: (day.costUsd ?? 0) > 0 ? "3px" : "0",
								}}
								title={label}
							/>
						</div>
					);
				})}
			</div>
			<div className="flex gap-1 mt-1">
				{daily.map((day, i) => {
					// Parse as local midnight: `new Date('2026-08-02')` is UTC and lands
					// on the previous day for anyone east of Greenwich.
					const [y, m, d] = day.date.split("-").map(Number);
					const dayLabel = new Date(y, m - 1, d).toLocaleDateString(locale, {
						weekday: "narrow",
					});
					const isToday = i === daily.length - 1;
					return (
						<div key={day.date} className="flex-1 text-center">
							<span
								className={`text-[10px] ${isToday ? "text-th-text-secondary" : "text-th-text-muted"}`}
							>
								{day.costUsd === undefined ? "?" : dayLabel}
							</span>
						</div>
					);
				})}
			</div>
		</Card>
	);
}
