import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ActiveChip } from "../../utils/historyFacets";

interface HistoryActiveChipsProps {
	chips: ActiveChip[];
	onRemove: (chip: ActiveChip) => void;
	onClearAll: () => void;
}

/**
 * One style for every axis.
 *
 * Five pastel colours on a reading surface read as confetti, and the colour
 * never said anything the value did not: nobody has to be told that
 * `hrdle-work-2` is a project.
 */
/** Removable chips for the active facet selection, with a Clear-all action. */
export function HistoryActiveChips({
	chips,
	onRemove,
	onClearAll,
}: HistoryActiveChipsProps) {
	const { t } = useTranslation();
	if (chips.length === 0) return null;
	return (
		<div className="flex items-center gap-1.5 flex-wrap">
			{chips.map((chip) => (
				<button
					type="button"
					key={`${chip.axis}:${chip.value}`}
					onClick={() => onRemove(chip)}
					className="inline-flex items-center gap-1 rounded-full border border-cv-border bg-cv-surface px-2.5 py-0.5 text-[11px] font-medium text-cv-text-secondary transition-colors hover:bg-cv-surface-hover"
				>
					{chip.label}
					<X className="h-3 w-3 opacity-60" />
				</button>
			))}
			<button
				type="button"
				onClick={onClearAll}
				className="px-2 py-0.5 text-[11px] text-cv-text-muted hover:text-cv-text"
			>
				{t("history.clearFilters")}
			</button>
		</div>
	);
}
