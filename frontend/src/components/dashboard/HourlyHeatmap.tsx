import { useTranslation } from "react-i18next";
import { Card } from "./Card";

interface HourlyHeatmapProps {
	data: Record<number, number>;
	className?: string;
}

// Time blocks for aggregation
const TIME_BLOCKS = [
	{ key: "timeBlock0_6", hours: [0, 1, 2, 3, 4, 5] },
	{ key: "timeBlock6_12", hours: [6, 7, 8, 9, 10, 11] },
	{ key: "timeBlock12_18", hours: [12, 13, 14, 15, 16, 17] },
	{ key: "timeBlock18_24", hours: [18, 19, 20, 21, 22, 23] },
];

export function HourlyHeatmap({ data, className = "" }: HourlyHeatmapProps) {
	const { t } = useTranslation();

	// Aggregate data by time blocks
	const blockData = TIME_BLOCKS.map((block) => ({
		key: block.key,
		label: t(`dashboard.${block.key}`),
		total: block.hours.reduce((sum, hour) => sum + (data[hour] || 0), 0),
	}));

	const maxValue = Math.max(...blockData.map((b) => b.total), 1);
	const totalActivity = blockData.reduce((sum, b) => sum + b.total, 0);

	return (
		<Card title={t("dashboard.hourlyActivity")} className={className}>
			<div className="space-y-1.5">
				{blockData.map((block) => {
					const percentage =
						totalActivity > 0
							? Math.round((block.total / totalActivity) * 100)
							: 0;
					const barWidth = (block.total / maxValue) * 100;
					const isPeak = block.total === maxValue && block.total > 0;

					return (
						<div key={block.key} className="flex items-center gap-2">
							<span className="text-[11px] text-th-text-muted w-14 shrink-0 tabular-nums">
								{block.label}
							</span>
							<div className="flex-1 h-3 bg-th-surface-hover rounded-full overflow-hidden">
								{/* One shade for the busiest block, one for the rest: the bars
								    are already ranked by length, so a uniform fill spent
								    colour without saying anything. */}
								<div
									className={`h-full rounded-full transition-[width] duration-300 ${
										isPeak ? "bg-emerald-400" : "bg-emerald-500/45"
									}`}
									style={{ width: `${barWidth}%` }}
								/>
							</div>
							<span className="text-[10px] text-th-text-muted w-8 text-right tabular-nums">
								{percentage}%
							</span>
						</div>
					);
				})}
			</div>
		</Card>
	);
}
