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
	if (since !== null) {
		return (
			<p className="flex items-center gap-2 px-1 pb-1 text-cv-text-muted text-xs">
				<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cv-text-muted" />
				{t("steward.working", "処理中…（経過 {{seconds}} 秒）", { seconds: elapsed })}
			</p>
		);
	}

	if (agentState === "processing") {
		return (
			<p className="flex items-center gap-2 px-1 pb-1 text-cv-accent text-xs">
				<span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-cv-accent" />
				{activity ? (
					<span className="min-w-0 truncate">
						<span className="font-medium">{activity.tool}</span>
						{activity.target && (
							<span className="ml-1.5 font-mono text-cv-text-muted">{activity.target}</span>
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
			<p className="flex items-center gap-2 px-1 pb-1 text-amber-500 text-xs">
				<span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
				{t("steward.agentWaiting", "このセッションは入力を待っています")}
			</p>
		);
	}

	return null;
}
