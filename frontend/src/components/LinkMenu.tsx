import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "../utils/clipboard";
import { LINK_MENU_EVENT } from "../utils/link-menu";

export function LinkMenu() {
	const { t } = useTranslation();
	const [url, setUrl] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		const onRequest = (e: Event) => {
			setCopied(false);
			setUrl((e as CustomEvent<string>).detail);
		};
		window.addEventListener(LINK_MENU_EVENT, onRequest);
		return () => window.removeEventListener(LINK_MENU_EVENT, onRequest);
	}, []);

	if (!url) return null;
	const close = () => setUrl(null);
	const canShare = typeof navigator.share === "function";

	const button =
		"w-full rounded-xl px-4 py-3 text-left text-base text-th-text active:bg-th-surface-hover";

	return (
		<div
			className="fixed inset-0 z-[10005] flex items-end justify-center bg-[var(--color-overlay)]"
			onClick={close}
			onKeyDown={(e) => e.key === "Escape" && close()}
			role="presentation"
		>
			<div
				role="dialog"
				aria-label={t("url.menuTitle")}
				className="w-full max-w-md rounded-t-2xl border border-th-border bg-th-surface p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<div className="break-all px-4 pb-2 pt-3 text-xs text-th-text-secondary">
					{url}
				</div>
				{canShare && (
					<button
						type="button"
						className={button}
						onClick={() => {
							close();
							navigator.share({ url }).catch(() => {});
						}}
					>
						{t("url.share")}
						<span className="block text-xs text-th-text-secondary">
							{t("url.shareHint")}
						</span>
					</button>
				)}
				<button
					type="button"
					className={button}
					onClick={async () => {
						setCopied(await copyText(url));
					}}
				>
					{copied ? t("url.copied") : t("url.copy")}
				</button>
				<button
					type="button"
					className={button}
					onClick={() => {
						close();
						window.open(url, "_blank", "noopener,noreferrer");
					}}
				>
					{t("url.openHere")}
				</button>
				<button
					type="button"
					className={`${button} text-center text-th-text-secondary`}
					onClick={close}
				>
					{t("common.cancel")}
				</button>
			</div>
		</div>
	);
}
