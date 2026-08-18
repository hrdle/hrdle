import { useTranslation } from "react-i18next";
import { Markdown } from "../ConversationViewer";
import { Linkified } from "./Linkified";

/**
 * What a turn says, all of it.
 *
 * The steward writes twice - `text` for the glasses' one page, `detail` for a
 * screen that can hold code and a diff - and this used to be rendered as a
 * collapsed `詳細` row under every message. That is the shape of an AI chat
 * rather than the shape of a conversation, and it was rejected on sight: a
 * disclosure triangle under each of five consecutive replies, every one of
 * which had to be opened to find out whether it held anything.
 *
 * The split is the *glasses'* constraint and does not follow the message onto a
 * phone. Here it is one message: the page-sized line, then the rest. The server
 * moves an over-long `text` into `detail`, so the two halves are often one
 * sentence cut in the middle - which is exactly what a toggle should never have
 * been across.
 */
export function TurnBody({ text, detail }: { text: string; detail?: string }) {
	return (
		<>
			<p className="whitespace-pre-wrap break-words">
				<Linkified text={text} />
			</p>
			{detail && (
				// The body's own colour, not `text-secondary`: dimmed, it reads as a
				// lesser block stapled underneath rather than as the same person
				// still talking. See `.cv-turn-detail` for the rest of it.
				<div className="cv-turn-detail mt-2">
					<Markdown content={detail} />
				</div>
			)}
		</>
	);
}

/**
 * When a turn was written.
 *
 * The clock time on its own, and the date only once it is no longer today: a
 * conversation is read as a sequence of moments and `2026/08/18` in front of
 * every one of them is a column of the same nine characters. Read through
 * `--cv-fs-meta` so it trails the body at every size rather than growing with
 * it - see `useChatFontSize`.
 */
export function TurnTime({ at, className = "" }: { at: number; className?: string }) {
	const { i18n } = useTranslation();
	const when = new Date(at);
	const time = when.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });
	const sameDay = new Date().toDateString() === when.toDateString();
	const date = sameDay ? "" : `${when.getMonth() + 1}/${when.getDate()} `;

	return (
		<time
			dateTime={when.toISOString()}
			className={`mt-1 block text-[length:var(--cv-fs-meta,12px)] text-cv-text-muted ${className}`}
		>
			{date}
			{time}
		</time>
	);
}
