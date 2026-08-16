import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../ConversationViewer";

/**
 * The half the glasses could not carry, behind a tap.
 *
 * Rendered open, a card is the glance plus everything the glance was meant to
 * spare them - and since the server moves an over-long `text` down here, the
 * open version is exactly the wall that made the pair worth having.
 */
export function TurnDetail({ detail }: { detail: string }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);

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
