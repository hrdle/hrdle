import { CornerDownLeft, ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IndicatorState } from "../../../../shared/types";
import { authFetch } from "../../services/api";
import { uploadImage } from "../../utils/upload-image";
import { StewardPendingAsk } from "./StewardPendingAsk";
import { StewardThinking } from "./StewardThinking";

const API_BASE = import.meta.env.VITE_API_URL || "";

/** Announces that something was said, so the turns on screen catch up without
 *  this component and the list having to be the same React subtree - on a phone
 *  they cannot be: the composer lives in the fixed bottom bar, where the soft
 *  keyboard cannot push it off, and the turns are in the pane area above. */
export const SAID_EVENT = "hrdle-steward-said";

/** An uploaded image: the path the message carries, and a local preview. */
interface Attachment {
	path: string;
	preview: string;
}

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
	agentState,
	activity,
}: {
	/** Unset on the overview, where what is said belongs to no session. */
	sessionId?: string;
	/** Routes the image upload, so the file lands on the host that will read it. */
	peerId?: string;
	className?: string;
	/** The overview uses this to open the thread, where the answer lands. */
	onSent?: () => void;
	/** What the agent in this session is doing, shown beside the composer. */
	agentState?: IndicatorState;
	activity?: { tool: string; target?: string };
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const fileRef = useRef<HTMLInputElement>(null);

	// The blob URLs are this tab's own; nothing else frees them.
	useEffect(() => {
		return () => {
			for (const a of attachments) URL.revokeObjectURL(a.preview);
		};
	}, [attachments]);

	const send = async () => {
		const text = draft.trim();
		if ((!text && attachments.length === 0) || sending) return;
		// A field, not a path pasted into the sentence: a screen can draw the
		// picture from it, and the steward can still hand the path to an agent
		// that opens files.
		const images = attachments.map((a) => a.path);
		setSending(true);
		try {
			const res = await authFetch(`${API_BASE}/api/steward/thread/reply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					text,
					...(images.length > 0 ? { images } : {}),
					...(sessionId ? { sessionId } : {}),
				}),
			});
			if (!res.ok) return;
			setDraft("");
			setAttachments([]);
			if (!sessionId) lastOverviewSay = Date.now();
			window.dispatchEvent(new CustomEvent(SAID_EVENT, { detail: { sessionId } }));
			onSent?.();
		} finally {
			setSending(false);
		}
	};

	// A thumbnail rather than the path in the text field: a path is not a
	// picture, and pasted into the line being typed it is not obviously
	// attached to anything either.
	const attach = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		e.target.value = "";
		setUploading(true);
		try {
			const result = await uploadImage(file, peerId);
			if (result.ok && result.path) {
				setAttachments((prev) => [
					...prev,
					{ path: result.path as string, preview: URL.createObjectURL(file) },
				]);
			}
		} finally {
			setUploading(false);
		}
	};

	const remove = (path: string) => {
		setAttachments((prev) => {
			const gone = prev.find((a) => a.path === path);
			if (gone) URL.revokeObjectURL(gone.preview);
			return prev.filter((a) => a.path !== path);
		});
	};

	return (
		// The column owns its own layout: a caller passing `items-end` for the
		// old single-row form aligned every child to the right instead, which
		// shrank the text field to its content and pushed it into the corner.
		<form
			className={`flex flex-col items-stretch ${className ?? "border-cv-border border-t bg-cv-bg p-2"}`}
			onSubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			{sessionId && <StewardPendingAsk sessionId={sessionId} />}

			<StewardThinking sessionId={sessionId} agentState={agentState} activity={activity} />

			{attachments.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-2">
					{attachments.map((a) => (
						<div key={a.path} className="relative">
							<img
								src={a.preview}
								alt={a.path}
								className="h-14 w-14 rounded-md object-cover"
							/>
							<button
								type="button"
								onClick={() => remove(a.path)}
								aria-label={t("steward.removeImage", "画像を外す")}
								className="-right-1 -top-1 absolute rounded-full bg-cv-surface p-0.5 text-cv-text-muted"
							>
								<X size={12} />
							</button>
						</div>
					))}
				</div>
			)}

			<div className="flex w-full items-end gap-1">
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
			{/* A textarea with the pane's own attributes, not a bare <input>.
			    Chrome reads a plain text field as a form and puts its
			    password / card / address strip above the keyboard; and a font
			    under 16px makes iOS zoom the page on focus. The pane's input bar
			    has carried both of these for as long as it has existed. */}
			<textarea
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					// `isComposing` is the whole point: Enter while a Japanese IME is
					// choosing a candidate confirms the candidate, and sending there
					// posts a half-typed word.
					if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
					e.preventDefault();
					void send();
				}}
				rows={Math.min(Math.max(draft.split("\n").length, 1), 5)}
				inputMode="text"
				autoCapitalize="off"
				autoCorrect="off"
				autoComplete="off"
				spellCheck={false}
				placeholder={t("steward.placeholder", "スチュワードに話しかける")}
				className="min-h-10 flex-1 resize-none rounded-lg bg-cv-surface px-3 py-2 text-cv-text outline-none"
				style={{ fontSize: "16px" }}
			/>
			<button
				type="submit"
				disabled={(!draft.trim() && attachments.length === 0) || sending}
				aria-label="Send"
				className="min-h-10 rounded-lg px-3 text-cv-text-muted disabled:opacity-40"
			>
				<CornerDownLeft size={18} />
			</button>
			</div>
		</form>
	);
}
