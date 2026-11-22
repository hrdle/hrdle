/**
 * A link tapped inside the installed app opens in the app's own in-app view,
 * never in the browser the person keeps tabs in, and nothing a page can do
 * changes that: the PWA *is* Chrome, so an `intent://` addressed to Chrome is
 * loaded by Chrome in place (measured: it replaced the Hrdle page itself).
 *
 * So a tap asks instead - open here, copy, or share - and the share sheet is
 * the one route out that the platform hands to the person rather than to us.
 * In a browser tab the ordinary link is already right and is left alone.
 */

export const LINK_MENU_EVENT = "hrdle:link-menu";

/** Exported for the test; components call `handleExternalLinkClick`. */
export function shouldOfferLinkMenu(standalone: boolean, url: string): boolean {
	return standalone && /^https?:\/\//i.test(url);
}

function isStandalone(): boolean {
	return (
		window.matchMedia?.("(display-mode: standalone)").matches === true ||
		(navigator as { standalone?: boolean }).standalone === true
	);
}

/**
 * `onClick` for an anchor that leaves the app. The `href` stays the plain URL,
 * so long-press keeps the platform's own copy / open-in-new-tab.
 */
export function handleExternalLinkClick(e: {
	currentTarget: HTMLAnchorElement;
	preventDefault(): void;
}): void {
	const url = e.currentTarget.href;
	if (!shouldOfferLinkMenu(isStandalone(), url)) return;
	e.preventDefault();
	window.dispatchEvent(new CustomEvent(LINK_MENU_EVENT, { detail: url }));
}
