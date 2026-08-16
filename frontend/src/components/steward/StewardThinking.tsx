import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useThinkingSince } from "./thinking";

/**
 * That the steward is working, and for how long.
 *
 * Beside the composer rather than at the end of the turns, and counting:
 * a still "考えています…" a screen away is indistinguishable from a screen
 * that has stopped updating, which is what someone waiting actually suspects.
 */
export function StewardThinking({ sessionId }: { sessionId?: string }) {
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

	if (since === null) return null;

	return (
		<p className="flex items-center gap-2 px-1 pb-1 text-cv-text-muted text-xs">
			<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cv-text-muted" />
			{t("steward.working", "処理中…（経過 {{seconds}} 秒）", { seconds: elapsed })}
		</p>
	);
}
