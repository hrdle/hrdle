/**
 * Getting a link out of an installed PWA.
 *
 * The manifest says `display: standalone`, so on Android an ordinary
 * `target="_blank"` to another origin opens a Custom Tab *inside* the app.
 * It is the real browser underneath, but it is not the browser the person has
 * tabs open in, and there is no web API that says "hand this to the default
 * handler".
 *
 * An `intent://` URL is the way there: Android resolves it through the intent
 * system rather than the page, and `S.browser_fallback_url` means a device
 * that will not resolve it still lands somewhere.
 *
 * Only Android, and only while standalone. In a browser tab the ordinary link
 * is already right, and iOS has no equivalent - `intent://` does nothing
 * there, so it must not be handed one.
 */

/** Whether a link needs the detour. Exported for the test; call `openExternal`. */
export function needsIntentEscape(
	ua: string,
	standalone: boolean,
	url: string,
): boolean {
	if (!standalone || !/android/i.test(ua)) return false;
	return /^https?:\/\//i.test(url);
}

/**
 * The browser app the intent is addressed to.
 *
 * Measured: an intent with no package was handed straight back to the app it
 * came from, so the link opened inside the PWA again. Naming the browser is
 * what gets past that, and Chrome is the one the WebAPK itself runs in - the
 * browser *app*, with the person's tabs, is a different surface from the
 * Custom Tab the PWA was opening.
 *
 * A device without it falls through to `browser_fallback_url`, which is no
 * worse than the behaviour this replaces. One constant, because swapping it
 * for another browser is a one-line change.
 */
const BROWSER_PACKAGE = "com.android.chrome";

/**
 * The same URL, addressed to Android's intent resolver.
 *
 * The scheme moves into the `#Intent` fragment - that is the format's own
 * rule, not a convenience - and the original goes in as the fallback.
 */
export function toIntentUrl(url: string): string {
	const parsed = new URL(url);
	const scheme = parsed.protocol.replace(":", "");
	const rest = url.slice(`${parsed.protocol}//`.length);
	return [
		`intent://${rest}#Intent`,
		`scheme=${scheme}`,
		`package=${BROWSER_PACKAGE}`,
		"action=android.intent.action.VIEW",
		`S.browser_fallback_url=${encodeURIComponent(url)}`,
		"end",
	].join(";");
}

function isStandalone(): boolean {
	return (
		window.matchMedia?.("(display-mode: standalone)").matches === true ||
		// iOS Safari's own flag. Read for completeness; the escape below is
		// Android-only, and this keeps the reason visible.
		(navigator as { standalone?: boolean }).standalone === true
	);
}

/**
 * Open a link the way the person expects from an app.
 *
 * Returns whether it took over: false means let the anchor do its own thing,
 * which is what every case outside an installed Android PWA wants.
 */
export function openExternal(url: string): boolean {
	if (!needsIntentEscape(navigator.userAgent, isStandalone(), url)) return false;
	window.location.href = toIntentUrl(url);
	return true;
}
