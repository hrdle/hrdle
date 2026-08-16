import { CornerDownLeft } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authFetch } from "../../services/api";

const API_BASE = import.meta.env.VITE_API_URL || "";

/** Announces that something was said, so the turns on screen catch up without
 *  this component and the list having to be the same React subtree - on a phone
 *  they cannot be: the composer lives in the fixed bottom bar, where the soft
 *  keyboard cannot push it off, and the turns are in the pane area above. */
export const SAID_EVENT = "hrdle-steward-said";

export function StewardSessionComposer({
	sessionId,
	className,
}: {
	sessionId: string;
	className?: string;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);

	const send = async () => {
		const text = draft.trim();
		if (!text || sending) return;
		setSending(true);
		try {
			const res = await authFetch(`${API_BASE}/api/steward/thread/reply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text, sessionId }),
			});
			if (!res.ok) return;
			setDraft("");
			window.dispatchEvent(new CustomEvent(SAID_EVENT, { detail: { sessionId } }));
		} finally {
			setSending(false);
		}
	};

	return (
		<form
			className={
				className ??
				"flex items-end gap-2 border-cv-border border-t bg-cv-bg p-2"
			}
			onSubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			<input
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				placeholder={t("steward.placeholder", "スチュワードに話しかける")}
				className="min-h-10 flex-1 rounded-lg bg-cv-surface px-3 text-sm text-cv-text outline-none"
			/>
			<button
				type="submit"
				disabled={!draft.trim() || sending}
				aria-label="Send"
				className="min-h-10 rounded-lg px-3 text-cv-text-muted disabled:opacity-40"
			>
				<CornerDownLeft size={18} />
			</button>
		</form>
	);
}
