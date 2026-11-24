import { useTranslation } from "react-i18next";
import type { PanelKey } from "./usePanePanel";

interface PanelCardProps {
	lines: string[];
	busy: boolean;
	error: string | null;
	onKey: (key: PanelKey) => void;
}

const ARROWS: Array<{ key: PanelKey; label: string; path: string }> = [
	{ key: "left", label: "conversation.panelLeft", path: "M15 6l-6 6 6 6" },
	{ key: "up", label: "conversation.panelUp", path: "M6 15l6-6 6 6" },
	{ key: "down", label: "conversation.panelDown", path: "M6 9l6 6 6-6" },
	{ key: "right", label: "conversation.panelRight", path: "M9 6l6 6-6 6" },
];

/**
 * A panel Claude Code drew over its input box, shown as the text it is, with
 * the keys it is driven by. The text keeps its columns - usage bars and tables
 * are laid out in them - so a narrow screen scrolls it sideways rather than
 * wrapping it into nonsense.
 */
export function PanelCard({ lines, busy, error, onKey }: PanelCardProps) {
	const { t } = useTranslation();
	const button =
		"flex h-9 shrink-0 items-center justify-center rounded-lg border border-cv-border text-cv-text-secondary hover:bg-cv-surface-hover disabled:opacity-50";
	return (
		<div
			className="mx-auto mb-2 flex max-h-[55vh] max-w-3xl flex-col overflow-hidden rounded-2xl border border-cv-text-muted/40 bg-cv-surface"
			data-testid="chat-panel"
		>
			<div className="flex items-center gap-2 px-3.5 pt-2.5">
				<span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
				<span className="flex-1 text-cv-text-muted text-xs">{t("conversation.panelOpen")}</span>
			</div>
			<pre className="mx-3.5 mt-1.5 min-h-0 flex-1 overflow-auto rounded-lg border border-cv-border bg-cv-bg px-2.5 py-2 font-mono text-[11.5px] text-cv-text-secondary leading-snug">
				{lines.join("\n")}
			</pre>
			<div className="flex items-center gap-1.5 px-3.5 pt-2 pb-2.5">
				{ARROWS.map((a) => (
					<button
						key={a.key}
						type="button"
						disabled={busy}
						onClick={() => onKey(a.key)}
						aria-label={t(a.label)}
						className={`${button} w-9`}
					>
						<svg
							className="h-4 w-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d={a.path} />
						</svg>
					</button>
				))}
				<span className="flex-1" />
				<button
					type="button"
					disabled={busy}
					onClick={() => onKey("enter")}
					className={`${button} px-3 text-sm`}
				>
					{t("conversation.panelEnter")}
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => onKey("esc")}
					className={`${button} px-3 text-sm`}
				>
					{t("conversation.panelClose")}
				</button>
			</div>
			{error && (
				<div className="px-3.5 pb-2 text-red-400 text-xs" role="alert">
					{error}
				</div>
			)}
		</div>
	);
}
