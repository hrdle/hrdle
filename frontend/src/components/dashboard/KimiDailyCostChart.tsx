import { useTranslation } from "react-i18next";
import type { KimiUsageDay } from "../../../../shared/types";
import { formatTokens, formatUsd } from "../../utils/format";
import { Card } from "./Card";

interface KimiDailyCostChartProps {
	daily: KimiUsageDay[];
}

const BAR_HEIGHT_PX = 64;
/** Up to this many bars, weekday initials fit under them; past it they blur. */
const WEEKDAY_LABEL_MAX = 8;

/**
 * What each day cost, and today's figure on the title row.
 *
 * The rolling windows next to this cannot answer "what has today cost me":
 * `last24h` read at 10:00 is mostly yesterday. So the buckets are local
 * calendar days (see `KimiUsageDay`), and today is the last bar.
 *
 * Cost only - never cost and tokens on one plot. They share no scale, and the
 * second axis it would take is the one thing a chart may not have. Tokens ride
 * along in each bar's tooltip, where they explain a bar rather than compete
 * with it.
 *
 * The range grows: seven days on a fresh install (all the log files can still
 * be read for) up to a month as completed days accumulate in the history file.
 */
export function KimiDailyCostChart({ daily }: KimiDailyCostChartProps) {
	const { t, i18n } = useTranslation();
	const locale = i18n.language === "ja" ? "ja" : "en";

	// Nothing in the range could be priced: this card is about money, so it has
	// nothing to say. The tokens are on the usage card either way.
	if (!daily.some((d) => d.costUsd !== undefined && d.costUsd > 0)) return null;

	const maxCost = Math.max(...daily.map((d) => d.costUsd ?? 0), 0.0001);
	const today = daily[daily.length - 1];
	const total = daily.reduce((sum, d) => sum + (d.costUsd ?? 0), 0);
	const unseen = daily.filter((d) => !d.observed).length;
	const perDayLabels = daily.length <= WEEKDAY_LABEL_MAX;

	const dateLabel = (date: string, opts: Intl.DateTimeFormatOptions) => {
		// Parse as local midnight: `new Date('2026-08-02')` is UTC and lands on
		// the previous day for anyone east of Greenwich.
		const [y, m, d] = date.split("-").map(Number);
		return new Date(y, m - 1, d).toLocaleDateString(locale, opts);
	};

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
			footnote={
				<>
					{t("dashboard.kimiDailyCostNote", {
						days: daily.length,
						total: formatUsd(total),
					})}
					{unseen > 0 && ` ${t("dashboard.kimiDailyCostUnseen", { count: unseen })}`}
				</>
			}
		>
			<div
				className="flex items-end gap-px sm:gap-1"
				style={{ height: `${BAR_HEIGHT_PX}px` }}
			>
				{daily.map((day, i) => {
					const isToday = i === daily.length - 1;
					const heightPx = Math.round(
						((day.costUsd ?? 0) / maxCost) * BAR_HEIGHT_PX,
					);
					const label = !day.observed
						? t("dashboard.kimiDailyCostUnseenDay", { date: day.date })
						: day.costUsd === undefined
							? t("dashboard.kimiDailyCostUnknown", { date: day.date })
							: `${day.date}: ${formatUsd(day.costUsd)} · ${formatTokens(day.totalTokens)} · ${t("dashboard.kimiTurns", { count: day.turns })}`;
					return (
						<div
							key={day.date}
							className="flex-1 flex flex-col items-center justify-end h-full"
							title={label}
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
							/>
						</div>
					);
				})}
			</div>
			<div className="flex gap-px sm:gap-1 mt-1">
				{daily.map((day, i) => {
					const isToday = i === daily.length - 1;
					const isFirst = i === 0;
					// Past a week or so the initials stop being readable and start
					// being a grey smear, so only the ends are named.
					const text = perDayLabels
						? day.observed
							? dateLabel(day.date, { weekday: "narrow" })
							: "·"
						: isFirst || isToday
							? dateLabel(day.date, { month: "numeric", day: "numeric" })
							: "";
					return (
						<div
							key={day.date}
							className={`flex-1 text-[10px] whitespace-nowrap ${
								perDayLabels
									? "text-center"
									: isFirst
										? "text-left"
										: "text-right"
							} ${isToday ? "text-th-text-secondary" : "text-th-text-muted"}`}
						>
							{text}
						</div>
					);
				})}
			</div>
		</Card>
	);
}
