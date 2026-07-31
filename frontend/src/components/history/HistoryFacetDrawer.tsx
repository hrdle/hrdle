import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface HistoryFacetDrawerProps {
	open: boolean;
	onClose: () => void;
	children: React.ReactNode;
}

/** Bottom-sheet wrapper for the facet sidebar on narrow screens. */
export function HistoryFacetDrawer({
	open,
	onClose,
	children,
}: HistoryFacetDrawerProps) {
	const { t } = useTranslation();
	if (!open) return null;
	return (
		<div className="fixed inset-0 z-40">
			<button
				type="button"
				aria-label={t("common.close")}
				onClick={onClose}
				className="absolute inset-0 bg-black/50"
			/>
			<div className="absolute bottom-0 left-0 right-0 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-cv-border bg-cv-bg px-4 pb-6 pt-3">
				<div className="sticky -top-3 -mx-4 mb-3 flex items-center justify-between bg-cv-bg px-4 py-2">
					<span className="text-[13px] font-medium text-cv-text">
						{t("history.filters")}
					</span>
					<button
						type="button"
						onClick={onClose}
						aria-label={t("common.close")}
						className="p-1 text-cv-text-muted hover:text-cv-text"
					>
						<X className="w-4 h-4" aria-hidden="true" />
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
