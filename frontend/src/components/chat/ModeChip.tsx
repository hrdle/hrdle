import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { authFetch } from "../../services/api";
import { paneUrl } from "./pane-url";

type Mode = "manual" | "acceptEdits" | "plan" | "auto" | "bypass";
/** What the chip offers. Bypass is shown when the pane is in it, never offered. */
const OFFERED: Exclude<Mode, "bypass">[] = ["manual", "acceptEdits", "plan", "auto"];

/** How often the mode is read again: Shift+Tab in herdr's own TUI changes it too. */
const REREAD_MS = 8000;

interface ModeChipProps {
	sessionId: string;
	paneId: string;
	peerId?: string;
	/** False while a question is open: Shift+Tab would go into its dialog. */
	readable: boolean;
}

/**
 * Claude Code's permission mode as a chip, and the menu that changes it. The
 * server cycles Shift+Tab and reads the footer after each press, so the chip
 * shows what the pane says rather than what was asked for.
 */
export function ModeChip({ sessionId, paneId, peerId, readable }: ModeChipProps) {
	const { t } = useTranslation();
	const [mode, setMode] = useState<Mode | null>(null);
	const [open, setOpen] = useState(false);
	const [changing, setChanging] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLDivElement>(null);

	const read = useCallback(async () => {
		try {
			const res = await authFetch(paneUrl(sessionId, paneId, peerId, "mode"));
			if (!res.ok) return;
			const data = (await res.json()) as { mode: Mode | null };
			// A screen with no input box on it (a dialog, a diff) says nothing
			// about the mode; keep the last answer.
			if (data.mode) setMode(data.mode);
		} catch {
			// The next read decides.
		}
	}, [sessionId, paneId, peerId]);

	useEffect(() => {
		if (!readable) return;
		void read();
		const timer = setInterval(read, REREAD_MS);
		return () => clearInterval(timer);
	}, [read, readable]);

	useEffect(() => {
		if (!open) return;
		const close = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [open]);

	const choose = async (next: Mode) => {
		setOpen(false);
		if (next === mode) return;
		setChanging(true);
		setError(null);
		try {
			const res = await authFetch(paneUrl(sessionId, paneId, peerId, "mode"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: next }),
			});
			const data = await res.json().catch(() => ({}));
			if (data.mode) setMode(data.mode);
			if (!res.ok) throw new Error(data.error || `status ${res.status}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setChanging(false);
		}
	};

	if (!mode) return null;

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((prev) => !prev)}
				disabled={changing || !readable}
				aria-expanded={open}
				aria-label={t("conversation.modeLabel", { mode: t(`conversation.mode.${mode}`) })}
				title={error ? t("conversation.modeFailed", { reason: error }) : undefined}
				className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] disabled:opacity-50 ${
					open
						? "border-cv-text-muted bg-cv-surface-hover text-cv-text"
						: error
							? "border-red-400/60 text-cv-text-secondary"
							: "border-cv-border text-cv-text-secondary hover:bg-cv-surface-hover"
				}`}
			>
				<svg
					className="h-3.5 w-3.5"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" />
				</svg>
				{t(`conversation.mode.${mode}`)}
				{changing ? (
					<span className="h-3 w-3 animate-spin rounded-full border-2 border-cv-text-muted border-t-transparent" />
				) : (
					<svg
						className="h-3 w-3 text-cv-text-muted"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth={2}
						aria-hidden="true"
					>
						<path d={open ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
					</svg>
				)}
			</button>
			{open && (
				<div
					role="menu"
					className="absolute bottom-11 left-0 z-10 w-72 overflow-hidden rounded-xl border border-cv-border bg-cv-surface shadow-black/30 shadow-lg"
				>
					<div className="px-3.5 pt-2.5 pb-1 text-cv-text-muted text-xs">
						{t("conversation.modeTitle")}
					</div>
					{OFFERED.map((m) => (
						<button
							key={m}
							type="button"
							role="menuitemradio"
							aria-checked={m === mode}
							onClick={() => void choose(m)}
							className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-cv-surface-hover ${
								m === mode ? "bg-cv-surface-hover" : ""
							}`}
						>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="text-[15px] text-cv-text">
									{t(`conversation.mode.${m}`)}
								</span>
								<span className="text-cv-text-muted text-xs">
									{t(`conversation.modeHint.${m}`)}
								</span>
							</span>
							{m === mode && (
								<svg
									className="h-4 w-4 shrink-0 text-cv-accent"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth={2.4}
									strokeLinecap="round"
									aria-hidden="true"
								>
									<path d="M5 12l5 5 9-10" />
								</svg>
							)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
