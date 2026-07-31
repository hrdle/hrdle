/**
 * Bracketed paste (DECSET 2004).
 *
 * A TUI treats everything between the markers as one pasted block rather than
 * a burst of keystrokes: newlines stay newlines instead of submitting, and a
 * paste handler gets to look at the whole thing at once.
 */
export function bracketedPaste(text: string): string {
	return `\x1b[200~${text}\x1b[201~`;
}

/**
 * An uploaded image's path, as the terminal would deliver a dropped file.
 *
 * Typed in character by character, the path stays a path: fifty characters of
 * upload directory and hex sitting in the prompt where the picture should be.
 * Claude Code recognises an image only in its paste handler — which is how a drag-and-drop arrives, since terminals
 * deliver dropped files as a paste — and replaces it with `[Image #1]`.
 * Verified against Claude Code 2.1.220: the same path, same pane, raw versus
 * wrapped, gives the literal path versus the placeholder.
 *
 * The space is outside the markers on purpose. Inside, it would be part of the
 * filename the agent goes looking for; outside, it just keeps the message the
 * user types next from butting against the placeholder.
 */
export function imagePastePayload(path: string): string {
	return `${bracketedPaste(path)} `;
}
