import { CornerDownLeft, ImagePlus } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { authFetch } from "../../services/api";
import { uploadImage } from "../../utils/upload-image";

const API_BASE = import.meta.env.VITE_API_URL || "";

/** Announces that something was said, so the turns on screen catch up without
 *  this component and the list having to be the same React subtree - on a phone
 *  they cannot be: the composer lives in the fixed bottom bar, where the soft
 *  keyboard cannot push it off, and the turns are in the pane area above. */
export const SAID_EVENT = "hrdle-steward-said";

/**
 * When something was last said from the overview.
 *
 * The event alone cannot carry it: saying it from the list opens the thread,
 * so the screen that wants to show "thinking" mounts *after* the event has
 * been dispatched and never hears it. Landing on your own sentence with no
 * sign of life is what made that screen read as broken.
 */
let lastOverviewSay = 0;
export function overviewSayPending(): boolean {
	return Date.now() - lastOverviewSay < 10_000;
}

export function StewardSessionComposer({
	sessionId,
	peerId,
	className,
	onSent,
}: {
	/** Unset on the overview, where what is said belongs to no session. */
	sessionId?: string;
	/** Routes the image upload, so the file lands on the host that will read it. */
	peerId?: string;
	className?: string;
	/** The overview uses this to open the thread, where the answer lands. */
	onSent?: () => void;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [uploading, setUploading] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	const send = async () => {
		const text = draft.trim();
		if (!text || sending) return;
		setSending(true);
		try {
			const res = await authFetch(`${API_BASE}/api/steward/thread/reply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(sessionId ? { text, sessionId } : { text }),
			});
			if (!res.ok) return;
			setDraft("");
			if (!sessionId) lastOverviewSay = Date.now();
			window.dispatchEvent(new CustomEvent(SAID_EVENT, { detail: { sessionId } }));
			onSent?.();
		} finally {
			setSending(false);
		}
	};

	// The path, not the picture: the steward reads text, and what it does with
	// an image is hand the path to an agent that can open it.
	const attach = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		e.target.value = "";
		setUploading(true);
		try {
			const result = await uploadImage(file, peerId);
			if (result.ok && result.path) {
				setDraft((prev) => (prev ? `${prev} ${result.path}` : (result.path ?? "")));
			}
		} finally {
			setUploading(false);
		}
	};

	return (
		<form
			className={
				className ?? "flex items-end gap-1 border-cv-border border-t bg-cv-bg p-2"
			}
			onSubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			<input
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp"
				className="hidden"
				ref={fileRef}
				onChange={attach}
			/>
			<button
				type="button"
				onClick={() => fileRef.current?.click()}
				disabled={uploading}
				aria-label={t("steward.attachImage", "画像を添付")}
				title={t("steward.attachImage", "画像を添付")}
				className="min-h-10 px-2 text-cv-text-muted disabled:opacity-40"
			>
				<ImagePlus size={18} />
			</button>
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
