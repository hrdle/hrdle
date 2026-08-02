import { useTranslation } from "react-i18next";
import { Card } from "./Card";

interface HourlyHeatmapProps {
	data: Record<number, number>;
	className?: string;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Hours that get a number under them. Every third would crowd the panel. */
const AXIS_HOURS = new Set([0, 6, 12, 18]);

const STEPS = [
	"bg-emerald-500/25",
	"bg-emerald-500/45",
	"bg-emerald-500/70",
	"bg-emerald-400",
];

/**
 * Intensity in one hue, stepped on the square root of the share.
 *
 * A sequential scale is one hue light-to-dark, so the steps are opacities of
 * the same green rather than a run through the spectrum. Zero gets the surface
 * colour instead of the palest green: "nothing happened" and "barely anything
 * did" are different statements, and at this cell size the palest step is
 * indistinguishable from empty anyway.
 *
 * The square root is not decoration. A day's activity is spiky - a nightly
 * batch hour can hold five times any other - and against a linear scale every
 * remaining hour fell into the first step and the row came out one flat shade
 * with two bright cells. Compressing the top end is what lets the other
 * twenty-two hours differ from each other.
 */
function cellClass(value: number, max: number): string {
	if (value === 0) return "bg-th-surface-hover";
	const step = Math.ceil(Math.sqrt(value / max) * STEPS.length);
	return STEPS[Math.min(step, STEPS.length) - 1] ?? STEPS[0];
}

/**
 * When the work happens, by the hour.
 *
 * It is named a heatmap and spent years drawing four bars: the payload has
 * been `hour -> count` for all 24 hours the whole time, and the component
 * summed them into 0-6 / 6-12 / 12-18 / 18-24. That is 170px to say "mornings
 * are busy", which is the one thing anyone already knows about their own day.
 * Twenty-four cells fit in less room and answer when you actually start.
 */
export function HourlyHeatmap({ data, className = "" }: HourlyHeatmapProps) {
	const { t } = useTranslation();

	const counts = HOURS.map((hour) => data[hour] || 0);
	const max = Math.max(...counts, 1);
	const total = counts.reduce((sum, value) => sum + value, 0);
	const peakHour = total > 0 ? counts.indexOf(max) : null;

	return (
		<Card
			title={t("dashboard.hourlyActivity")}
			className={className}
			aside={
				peakHour !== null ? (
					<span className="text-[11px] text-th-text-muted shrink-0">
						{t("dashboard.hourlyPeak")}{" "}
						<span className="text-th-text-secondary tabular-nums font-medium">
							{t("dashboard.hourLabel", { hour: peakHour })}
						</span>
					</span>
				) : undefined
			}
		>
			<div className="flex gap-px">
				{HOURS.map((hour) => (
					<div
						key={hour}
						className={`flex-1 h-5 rounded-sm ${cellClass(counts[hour], max)}`}
						title={`${t("dashboard.hourLabel", { hour })} · ${counts[hour]}`}
					/>
				))}
			</div>
			<div className="flex gap-px mt-1">
				{HOURS.map((hour) => (
					<div
						key={hour}
						className="flex-1 text-[9px] text-th-text-muted text-center tabular-nums whitespace-nowrap"
					>
						{AXIS_HOURS.has(hour) ? hour : ""}
					</div>
				))}
			</div>
		</Card>
	);
}
