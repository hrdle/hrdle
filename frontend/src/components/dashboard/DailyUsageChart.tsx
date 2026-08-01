import { useTranslation } from "react-i18next";
import type { DailyActivity } from "../../../../shared/types";
import { Card } from "./Card";

interface DailyUsageChartProps {
	data: DailyActivity[];
}

export function DailyUsageChart({ data }: DailyUsageChartProps) {
	const { t, i18n } = useTranslation();

	if (data.length === 0) {
		return (
			<Card title={t("dashboard.dailyStats")}>
				<div className="text-th-text-muted text-xs">
					{t("dashboard.noActivityData")}
				</div>
			</Card>
		);
	}

	// Get last 7 days for display
	const recentData = data.slice(-7);
	const maxMessages = Math.max(...recentData.map((d) => d.messageCount), 1);
	const locale = i18n.language === "ja" ? "ja" : "en";
	const today = recentData[recentData.length - 1];

	return (
		<Card
			title={t("dashboard.dailyStats")}
			// The day's total was a centered sentence under the chart. On the title
			// row it is the same fact in the place the eye already is.
			aside={
				<span className="text-[11px] text-th-text-muted shrink-0">
					{t("dashboard.today")}{" "}
					<span className="text-th-text-secondary tabular-nums font-medium">
						{(today?.messageCount ?? 0).toLocaleString(locale)}
					</span>
				</span>
			}
		>
			<div className="flex items-end gap-1" style={{ height: "64px" }}>
				{recentData.map((day, i) => {
					const heightPx = Math.round((day.messageCount / maxMessages) * 64);
					const isToday = i === recentData.length - 1;
					return (
						<div
							key={day.date}
							className="flex-1 flex flex-col items-center justify-end h-full"
						>
							<div
								className={`w-full rounded-t transition-colors ${
									isToday ? "bg-blue-400" : "bg-blue-500/50"
								}`}
								style={{
									height: `${heightPx}px`,
									minHeight: day.messageCount > 0 ? "3px" : "0",
								}}
								title={`${day.date}: ${day.messageCount} messages`}
							/>
						</div>
					);
				})}
			</div>
			<div className="flex gap-1 mt-1">
				{recentData.map((day, i) => {
					const date = new Date(day.date);
					const dayLabel = date.toLocaleDateString(locale, {
						weekday: "narrow",
					});
					const isToday = i === recentData.length - 1;
					return (
						<div key={day.date} className="flex-1 text-center">
							<span
								className={`text-[10px] ${isToday ? "text-th-text-secondary" : "text-th-text-muted"}`}
							>
								{dayLabel}
							</span>
						</div>
					);
				})}
			</div>
		</Card>
	);
}
