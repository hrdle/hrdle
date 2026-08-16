import { openExternal } from "../../utils/external-link";
import { splitLinks } from "../../utils/terminal-links";

/**
 * A message's prose, with its links tappable.
 *
 * The steward writes URLs into what it says - a release, a PR, a page it wants
 * looked at - and on a phone a URL that is only text has to be selected and
 * copied by hand, which on a touch keyboard nobody does.
 */
export function Linkified({ text }: { text: string }) {
	const parts = splitLinks(text);
	if (parts.length === 1 && "text" in parts[0]) return <>{text}</>;

	return (
		<>
			{parts.map((part, i) =>
				"url" in part ? (
					<a
						// A URL can legitimately appear twice in one message.
						// biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional
						key={`${part.url}-${i}`}
						href={part.url}
						target="_blank"
						rel="noopener noreferrer"
						// The href stays the plain URL so long-press still offers copy
						// and open-in-new-tab; only the tap is redirected, and only
						// from an installed Android PWA.
						onClick={(e) => {
							if (openExternal(part.url)) e.preventDefault();
						}}
						className="text-sky-300 underline underline-offset-2"
					>
						{part.url}
					</a>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional
					<span key={`t-${i}`}>{part.text}</span>
				),
			)}
		</>
	);
}
