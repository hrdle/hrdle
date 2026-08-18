import { useTranslation } from "react-i18next";
import { Linkified } from "./Linkified";

/**
 * What a turn says.
 *
 * The `detail` is not here: it is behind a tap, in `TurnDetail`. It was inlined
 * for a day on a misread of "this is an AI thing, I do not need it" - which was
 * about the coloured rule down the card's edge, not about the disclosure - and
 * putting it back is the correction, not a second opinion about which is
 * better.
 */
export function TurnBody({ text }: { text: string }) {
	return (
		<p className="whitespace-pre-wrap break-words">
			<Linkified text={text} />
		</p>
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
