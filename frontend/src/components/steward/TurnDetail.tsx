import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../ConversationViewer";

/**
 * The half the glasses could not carry, behind a tap.
 *
 * Rendered open, a card is the glance plus everything the glance was meant to
 * spare them - and since the server moves an over-long `text` down here, the
 * open version is exactly the wall that made the pair worth having.
 *
 * `startOpen` is the one exception, and it is the newest reply: what has just
 * arrived is what someone came to read, and asking them to tap it is asking
 * them to tap the thing they are already looking at. Everything older stays
 * shut - see `newestWithDetail`.
 */
export function TurnDetail({ detail, startOpen = false }: { detail: string; startOpen?: boolean }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(startOpen);

	// The newest reply is not the same entry for long. When one arrives, this
	// one stops being it and shuts again; `useState` alone runs once and would
	// leave a column of open details behind. Keyed on the prop changing rather
	// than on every render, so a detail opened by hand is not shut under
	// whoever opened it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `startOpen` changing is the event; `open` is what it sets.
	useEffect(() => {
		setOpen(startOpen);
	}, [startOpen]);

	return (
		<div className="mt-2 border-cv-border border-t pt-2">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex min-h-[32px] items-center gap-1 text-cv-text-muted text-xs hover:text-cv-text"
			>
				{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				{open ? t("steward.detailHide", "詳細を閉じる") : t("steward.detailShow", "詳細")}
			</button>
			{open && (
				<div className="mt-1 text-cv-text-secondary">
					<Markdown content={detail} />
				</div>
			)}
		</div>
	);
}

/**
 * Which entry is "the newest reply".
 *
 * The last one *carrying a detail*, not simply the last one. A person's own
 * message has no detail, so with the plain rule typing "thanks" would shut the
 * answer they were reading - content disappearing as a side effect of their own
 * typing, which is the worse of the two failures by a distance.
 */
export function newestWithDetail(entries: { id: string; detail?: string }[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.detail?.trim()) return entry.id;
	}
	return null;
}
