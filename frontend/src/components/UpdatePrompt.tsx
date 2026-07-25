import { useTranslation } from "react-i18next";
import { useServiceWorkerUpdate } from "../hooks/useServiceWorkerUpdate";

/**
 * Bottom sheet shown when a new release has been precached, asking before the
 * page reloads. Mounted next to <App /> so every layout (mobile / tablet /
 * desktop) gets it from one place.
 */
export function UpdatePrompt() {
	const { t } = useTranslation();
	const { updateAvailable, dismiss, reload } = useServiceWorkerUpdate();

	if (!updateAvailable) return null;

	// z-10010 keeps it above every other overlay — onboarding and the elevated
	// floating keyboard both sit at z-10000+ and would swallow the clicks.
	return (
		<div
			role="alertdialog"
			aria-labelledby="cchub-update-title"
			className="fixed inset-x-0 bottom-0 z-[10010] flex justify-center px-3 pointer-events-none"
			style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 12px)" }}
		>
			<div className="pointer-events-auto w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 shadow-xl">
				<p
					id="cchub-update-title"
					className="text-sm font-medium text-zinc-200"
				>
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
