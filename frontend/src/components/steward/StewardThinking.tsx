import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IndicatorState } from "../../../../shared/types";
import { useThinkingSince } from "./thinking";

/**
 * That the steward is working, and for how long.
 *
 * Beside the composer rather than at the end of the turns, and counting:
 * a still "考えています…" a screen away is indistinguishable from a screen
 * that has stopped updating, which is what someone waiting actually suspects.
 */
export function StewardThinking({
	sessionId,
	agentState,
	activity,
}: {
	sessionId?: string;
	/** What the agent in this session is doing. The list shows it on every row;
	 *  reading one session there was nothing to tell a working pane from a
	 *  finished one. */
	agentState?: IndicatorState;
	/** The tool call it is on, when there is one. "Working" alone reads the
	 *  same as a screen that has stopped updating. */
	activity?: { tool: string; target?: string };
}) {
	const { t } = useTranslation();
	const since = useThinkingSince(sessionId ?? "");
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		if (since === null) return;
		const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - since) / 1000)));
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	}, [since]);

	// The steward's own turn takes precedence: it is the answer being waited on.
	// 13px, not `text-xs`. The app's root font is 14px, so `text-xs` renders at
	// 10.5px - readable at a desk and not at arm's length on a phone, which is
	// where this line is for.
	const row = "flex items-center gap-2 px-1 pt-0.5 pb-1.5 text-[13px]";
	const dot = "inline-block h-2 w-2 shrink-0 rounded-full";

	if (since !== null) {
		return (
			<p className={`${row} text-cv-text-muted`}>
				<span className={`${dot} animate-pulse bg-cv-text-muted`} />
				{t("steward.working", "処理中…（経過 {{seconds}} 秒）", { seconds: elapsed })}
			</p>
		);
	}

	if (agentState === "processing") {
		return (
			<p className={`${row} text-cv-accent`}>
				<span className={`${dot} animate-pulse bg-cv-accent`} />
				{activity ? (
					<span className="min-w-0 truncate">
						<span className="font-semibold">{activity.tool}</span>
						{activity.target && (
							<span className="ml-2 font-mono text-cv-text-secondary">{activity.target}</span>
						)}
					</span>
				) : (
					t("steward.agentWorking", "このセッションは作業中です")
				)}
			</p>
		);
	}

	if (agentState === "waiting_input") {
		return (
			<p className={`${row} text-amber-500`}>
				<span className={`${dot} bg-amber-500`} />
				{t("steward.agentWaiting", "このセッションは入力を待っています")}
			</p>
		);
	}

	return null;
}
