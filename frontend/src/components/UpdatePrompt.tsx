import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useServiceWorkerUpdate } from "../hooks/useServiceWorkerUpdate";

/**
 * Asks before reloading onto a new release, and keeps saying so if waved away.
 *
 * At the top, not the bottom. Every layout puts something it needs at the
 * bottom edge - the phone's session bar, the steward's composer - so a bottom
 * sheet covered the control the person was reaching for, and waving it away to
 * get at that control used to also throw away the only sign the page was on an
 * old build. The fix then looked like a fix that had not worked.
 *
 * Mounted next to <App /> so every layout gets it from one place.
 */
export function UpdatePrompt() {
	const { t } = useTranslation();
	const { updateAvailable, dismissed, dismiss, reload } = useServiceWorkerUpdate();

	if (!updateAvailable) return null;

	// z-10010 keeps it above every other overlay — onboarding and the elevated
	// floating keyboard both sit at z-10000+ and would swallow the clicks.
	// No top inset here: `#root` carries it, and its `translateY` is what a
	// `position: fixed` child is positioned against - see layout-insets.test.ts.
	const frame =
		"fixed inset-x-0 top-0 z-[10010] flex justify-center px-3 pt-2 pointer-events-none";

	// Waved away: what is left says the page is old and reloads on a tap. Small
	// enough to ignore, present enough that nobody wonders why a fix is missing.
	if (dismissed) {
		return (
			<div className={frame}>
				<button
					type="button"
					onClick={reload}
					className="pointer-events-auto flex min-h-8 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/90 px-3 text-xs text-zinc-300 shadow-lg backdrop-blur"
				>
					<RefreshCw className="h-3 w-3" />
					{t("update.pending", "更新あり")}
				</button>
			</div>
		);
	}

	return (
		<div role="alertdialog" aria-labelledby="hrdle-update-title" className={frame}>
			<div className="pointer-events-auto w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 shadow-xl">
				<p id="hrdle-update-title" className="text-sm font-medium text-zinc-200">
					{t("update.available")}
				</p>
				<p className="mt-1 text-xs text-zinc-400">{t("update.description")}</p>
				<div className="mt-3 flex justify-end gap-2">
					<button
						type="button"
						onClick={dismiss}
						className="min-h-11 px-4 text-sm text-zinc-400 hover:text-zinc-200"
					>
						{t("update.later")}
					</button>
					<button
						type="button"
						onClick={reload}
						className="min-h-11 rounded bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-500"
					>
						{t("update.reload")}
					</button>
				</div>
			</div>
		</div>
	);
}
