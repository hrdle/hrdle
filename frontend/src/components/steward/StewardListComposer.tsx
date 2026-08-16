import { CornerDownLeft } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authFetch } from "../../services/api";

const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * Saying something to the steward from the overview.
 *
 * The requests that belong to no single session - reorder these, bring that one
 * back from history - are made while looking at the list, and reaching them
 * meant opening another screen first. Sending opens the thread, because that is
 * where the answer arrives and a reply nobody sees is the failure this whole
 * area keeps producing.
 */
export function StewardListComposer({ onSent }: { onSent: () => void }) {
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
				body: JSON.stringify({ text }),
			});
			if (!res.ok) return;
			setDraft("");
			onSent();
		} finally {
			setSending(false);
		}
	};

	return (
		<form
			className="shrink-0 flex items-end gap-2 border-white/[0.06] border-t bg-[#0a0a0a] p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
			onSubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			<input
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				placeholder={t("steward.placeholder", "スチュワードに話しかける")}
				className="min-h-10 flex-1 rounded-lg bg-white/[0.06] px-3 text-[13px] text-white outline-none placeholder:text-zinc-500"
			/>
			<button
				type="submit"
				disabled={!draft.trim() || sending}
				aria-label="Send"
				className="min-h-10 rounded-lg px-3 text-zinc-400 disabled:opacity-40"
			>
				<CornerDownLeft className="h-[18px] w-[18px]" />
			</button>
		</form>
	);
}
