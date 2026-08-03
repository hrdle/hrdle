import { useTranslation } from "react-i18next";
import type { GroqSttUsageSummary } from "../../../../shared/types";
import { formatUsd } from "../../utils/format";
import { Card, StatTile } from "./Card";

interface GroqSttUsageCardProps {
	usage: GroqSttUsageSummary;
	className?: string;
}

const BAR_HEIGHT_PX = 40;

/** Audio durations read as minutes past a minute, and as seconds below one. */
function formatAudio(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = seconds / 60;
	return minutes < 10 ? `${minutes.toFixed(1)}m` : `${Math.round(minutes)}m`;
}

/**
 * What the glasses' voice input has cost, and how much quota is left.
 *
 * Two quotas, because Groq caps two different things and they empty on
 * different clocks: requests per day and audio seconds per hour. A remaining
 * bar is drawn for each one Groq actually reported - it reports them on the
 * transcription response, so a fresh server has none until the first thing is
 * said, and a missing bar means "not measured yet" rather than "full".
 *
 * The cost is an estimate at the list price per hour of audio. Groq bills on
 * its own rounding and this server never sees the invoice, which is why the
 * figure is labelled rather than presented as a balance.
 */
export function GroqSttUsageCard({ usage, className = "" }: GroqSttUsageCardProps) {
	const { t } = useTranslation();
	const { today, last7d, daily, rateLimit } = usage;
	const maxAudio = Math.max(...daily.map((d) => d.audioSeconds), 1);

	const quotas = [
		{
			key: "requests",
			label: t("dashboard.groqSttQuotaRequests"),
			remaining: rateLimit?.remainingRequests,
			limit: rateLimit?.limitRequests,
			reset: rateLimit?.resetRequests,
			format: (value: number) => `${value}`,
		},
		{
			key: "audio",
			label: t("dashboard.groqSttQuotaAudio"),
			remaining: rateLimit?.remainingAudioSeconds,
			limit: rateLimit?.limitAudioSeconds,
			reset: rateLimit?.resetAudioSeconds,
			format: formatAudio,
		},
	].filter((q) => q.remaining !== undefined && q.limit !== undefined && q.limit > 0);

	return (
		<Card
			title={t("dashboard.groqStt")}
			aside={
				<span className="text-[11px] text-th-text-muted shrink-0 truncate">
					{usage.model}
				</span>
			}
			className={className}
			footnote={
				<>
					{t("dashboard.groqSttNote", {
						requests: last7d.requests,
						audio: formatAudio(last7d.audioSeconds),
						cost: formatUsd(last7d.costUsd),
					})}
					{last7d.failures > 0 &&
						` ${t("dashboard.groqSttFailures", { count: last7d.failures })}`}
				</>
			}
		>
			<div className="grid grid-cols-3 gap-2">
				<StatTile label={t("dashboard.groqSttRequests")}>
					<div className="text-lg font-semibold text-th-text tabular-nums">
						{today.requests}
					</div>
				</StatTile>
				<StatTile label={t("dashboard.groqSttAudio")}>
					<div className="text-lg font-semibold text-th-text tabular-nums">
						{formatAudio(today.audioSeconds)}
					</div>
				</StatTile>
				<StatTile label={t("dashboard.groqSttCost")}>
					<div className="text-lg font-semibold text-emerald-300 tabular-nums">
						{/* Four decimals is right for a figure that spends whole days
						    below a cent, but the tile is not wide enough to read them. */}
						{today.costUsd > 0 && today.costUsd < 0.01
							? "<$0.01"
							: formatUsd(today.costUsd)}
					</div>
				</StatTile>
			</div>

			<div
				className="flex items-end gap-px sm:gap-1 mt-3"
				style={{ height: `${BAR_HEIGHT_PX}px` }}
				aria-hidden="true"
			>
				{daily.map((day, i) => {
					const isToday = i === daily.length - 1;
					return (
						<div
							key={day.date}
							className="flex-1 flex flex-col justify-end h-full min-w-0"
							title={`${day.date}: ${day.requests} · ${formatAudio(day.audioSeconds)}`}
						>
							<div
								className={`w-full rounded-t ${isToday ? "bg-sky-400" : "bg-sky-500/50"}`}
								style={{
									height: `${Math.round((day.audioSeconds / maxAudio) * BAR_HEIGHT_PX)}px`,
									// A day with speech in it must never round away to nothing:
									// "barely used" and "not used" are different answers.
									minHeight: day.audioSeconds > 0 ? "3px" : "0",
								}}
							/>
						</div>
					);
				})}
			</div>

			{quotas.length > 0 && (
				<div className="mt-3 space-y-2">
					{quotas.map((quota) => {
						const remaining = quota.remaining as number;
						const limit = quota.limit as number;
						const ratio = Math.max(0, Math.min(1, remaining / limit));
						return (
							<div key={quota.key}>
								<div className="flex items-baseline justify-between gap-2 text-[11px]">
									<span className="text-th-text-muted truncate">{quota.label}</span>
									<span className="text-th-text-secondary tabular-nums shrink-0">
										{quota.format(remaining)} / {quota.format(limit)}
									</span>
								</div>
								<div className="mt-1 h-1 rounded-full bg-white/[0.06] overflow-hidden">
									<div
										className={`h-full rounded-full ${
											ratio < 0.15 ? "bg-red-400" : "bg-sky-400/70"
										}`}
										style={{ width: `${ratio * 100}%` }}
									/>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</Card>
	);
}
