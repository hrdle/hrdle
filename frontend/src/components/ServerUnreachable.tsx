import { useTranslation } from "react-i18next";
import { currentHostIsTailnet } from "../utils/tailnet";

/**
 * What to say when the server does not answer.
 *
 * Hrdle is served over Tailscale, so from a phone or a tablet the common cause
 * is by far the VPN being off on that device - and the screen that used to be
 * shown said nothing at all, an empty session list that reads like "no sessions
 * exist". Named advice only where the address supports it: a host that is not
 * recognisably tailnet gets the generic line rather than a guess.
 */
function useHint(): string {
	const { t } = useTranslation();
	return currentHostIsTailnet()
		? t("connection.tailscaleHint")
		: t("connection.genericHint");
}

/** One muted line, for a screen that already says the connection failed. */
export function ServerUnreachableHint({
	className = "",
}: {
	className?: string;
}) {
	const hint = useHint();
	return (
		<p className={`text-th-text-muted text-xs max-w-xs text-center ${className}`}>
			{hint}
		</p>
	);
}

/** The whole message, for where a list or a screen would otherwise be blank. */
export function ServerUnreachableNotice({
	onRetry,
	className = "",
}: {
	onRetry?: () => void;
	className?: string;
}) {
	const { t } = useTranslation();
	const hint = useHint();

	return (
		<div
			className={`flex flex-col items-center justify-center gap-2 text-center px-6 py-12 ${className}`}
		>
			<p className="text-[14px] text-amber-400">{t("connection.unreachable")}</p>
			<p className="text-[12px] text-zinc-500 max-w-xs leading-relaxed">
				{hint}
			</p>
			{onRetry && (
				<button
					type="button"
					onClick={onRetry}
					className="mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-md text-white text-[13px] font-medium transition-colors"
				>
					{t("connection.retry")}
				</button>
			)}
			<p className="text-[11px] text-zinc-600 mt-1">
				{t("connection.retryingAutomatically")}
			</p>
		</div>
	);
}

/** A strip above a list that is still showing what it last managed to load. */
export function ServerUnreachableBanner() {
	const { t } = useTranslation();
	const hint = useHint();

	return (
		<div className="mb-3 p-2.5 bg-amber-900/20 border border-amber-700/30 rounded-lg text-[12px] text-amber-400">
			<div>{t("connection.staleList")}</div>
			<div className="text-amber-400/70 mt-0.5">{hint}</div>
		</div>
	);
}
