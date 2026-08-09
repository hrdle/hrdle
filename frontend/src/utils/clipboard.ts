/**
 * Write to the clipboard, with the textarea fallback still in place.
 *
 * `navigator.clipboard` needs a secure context and a gesture the browser
 * agrees was a gesture. Hrdle is served over HTTPS, so the usual failure is
 * the second one — a copy reached from a touch handler that the browser has
 * already decided is not user activation. `execCommand("copy")` predates that
 * rule and still works there.
 */
export async function copyText(text: string): Promise<boolean> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// fall through to the textarea
		}
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.cssText = "position:fixed;left:-9999px;top:-9999px";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}
