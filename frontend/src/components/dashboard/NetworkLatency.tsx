import { useTranslation } from "react-i18next";
import { useNetworkLatency } from "../../hooks/useNetworkLatency";

function getLatencyColor(value: number): string {
	if (value < 50) return "text-green-400";
	if (value < 150) return "text-yellow-400";
	return "text-red-400";
}

/**
 * WebSocket and API round-trip, as a title-row aside.
 *
 * This was a card of its own and spent 116px on two numbers, most of it the
 * box. It also sat above the list of peer servers while describing only the
 * link to one of them, so it now rides on that server's card instead.
 *
 * The sparklines did not come along: at three pixels a bar they were texture,
 * and the colour of the number already says good, slow or bad.
 */
export function NetworkLatencyInline() {
	const { t } = useTranslation();
	const { wsLatency, apiLatency, wsConnected } = useNetworkLatency();
	// A reading from a socket that has since dropped is history, not status.
	const stale = !wsConnected && wsLatency !== null;

	return (
		<span
			className="text-[10px] tabular-nums whitespace-nowrap text-th-text-muted"
			title={`${t("dashboard.websocket")} / ${t("dashboard.api")} — ${t("dashboard.networkLatency")}`}
		>
			<span
				className={
					stale || wsLatency === null
						? "text-th-text-muted"
						: getLatencyColor(wsLatency)
				}
			>
				{wsLatency !== null ? `${wsLatency}ms` : t("dashboard.latencyNA")}
			</span>
			<span className="mx-1 opacity-40">·</span>
			<span
				className={
					apiLatency !== null ? getLatencyColor(apiLatency) : "text-th-text-muted"
				}
			>
				{apiLatency !== null ? `${apiLatency}ms` : t("dashboard.latencyNA")}
			</span>
		</span>
	);
}
