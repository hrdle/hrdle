import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	MAX_FONTSIZE,
	MIN_FONTSIZE,
	useViewerSettings,
} from "../../hooks/useViewerSettings";

interface ViewerSettingsMenuProps {
	/** Word wrap is remembered per file name, as the viewers read it. */
	fileName: string;
	/** Which way the menu opens: up from a bottom bar, down from a header. */
	placement: "up" | "down";
}

/**
 * Text size and wrapping for the file on screen, from one button in the
 * toolbar. These used to float over the top-right of the text itself, where
 * they covered the end of the first lines and could not be moved.
 */
export function ViewerSettingsMenu({ fileName, placement }: ViewerSettingsMenuProps) {
	const { t } = useTranslation();
	const { fontSize, commitFontSize, wordWrap, toggleWordWrap } =
		useViewerSettings(fileName);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open]);

	const step = "h-8 w-8 rounded-lg border border-[#333] bg-th-surface text-base text-th-text disabled:opacity-40";

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-label={t("files.viewSettings")}
				aria-expanded={open}
				className={`flex h-10 w-10 items-center justify-center rounded-lg text-[15px] font-semibold ${open ? "bg-th-surface-hover text-th-text" : "text-th-text-secondary"}`}
			>
				Aa
			</button>
			{open && (
				<div
					className={`absolute right-0 z-20 w-60 rounded-2xl border border-[#333] bg-[#1a1a1a] py-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.6)] ${placement === "up" ? "bottom-12" : "top-12"}`}
				>
					<div className="flex items-center px-3.5 py-2 text-[13px] text-th-text">
						{t("files.fontSize")}
						<div className="ml-auto flex items-center gap-1">
							<button
								type="button"
								aria-label={t("files.zoomOut")}
								disabled={fontSize <= MIN_FONTSIZE}
								onClick={() => commitFontSize(Math.max(MIN_FONTSIZE, fontSize - 1))}
								className={step}
							>
								−
							</button>
							<span className="w-10 text-center font-mono text-xs text-th-text-secondary">
								{fontSize}px
							</span>
							<button
								type="button"
								aria-label={t("files.zoomIn")}
								disabled={fontSize >= MAX_FONTSIZE}
								onClick={() => commitFontSize(Math.min(MAX_FONTSIZE, fontSize + 1))}
								className={step}
							>
								+
							</button>
						</div>
					</div>
					<label className="flex cursor-pointer items-center px-3.5 py-2.5 text-[13px] text-th-text">
						{t("files.wrap")}
						<input
							type="checkbox"
							checked={wordWrap}
							onChange={toggleWordWrap}
							className="peer sr-only"
						/>
						<span className="relative ml-auto h-[22px] w-9 rounded-full bg-zinc-700 transition-colors peer-checked:bg-blue-600 after:absolute after:left-[3px] after:top-[3px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-[14px]" />
					</label>
				</div>
			)}
		</div>
	);
}
