/**
 * URL extraction from a rendered pane viewport.
 *
 * Hrdle's frontend never sees the raw PTY stream — it applies `PaneViewport`
 * frames, one string per screen row. A URL wider than the pane is therefore
 * several unrelated strings by the time it arrives here, and xterm's own link
 * addon cannot put them back together: it stitches rows using the buffer's
 * wrap flag, and every row `viewportToVTSequence` writes is absolutely
 * positioned, so none is ever marked wrapped.
 *
 * The flag would not settle it even with a raw stream. Claude Code's TUI
 * hard-wraps its own output at the pane width, so herdr's `recent_unwrapped`
 * read — which does consult the wrap flag — returns exactly the same
 * 120-column pieces as `visible`. Measured against its login screen on
 * 2026-08-09, which is what this exists for: `c to copy` writes an OSC 52
 * sequence that herdr's renderer consumes and never re-emits, so on a tablet
 * that URL has no other way out of the pane.
 *
 * What is left is the boundary itself. A URL that ends at the last column of a
 * row that is full was cut there, and continues with the leading run of
 * URL characters on the row below. That is the only join made here — both
 * halves of the test matter, since "ends the row" alone would glue
 * `see http://example.com` to a `foo=bar` beneath it. An OAuth URL is worth
 * nothing if one character is wrong, so the rule is deliberately narrow: it
 * would rather return a truncated URL than an invented one.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes by design.
const ANSI_RE = /\x1b\[[\d;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * A row as plain characters.
 *
 * herdr's `pane.read` returns CRLF-terminated rows and `captureViewportHerdr`
 * splits on `\n`, so every line arrives carrying a trailing `\r`. It renders as
 * nothing, but it is a character: left on, a full 160-column row measures 161
 * and no longer looks full, which silently cost the join for every wrapped URL
 * (seen on a live pane on 2026-08-09, after the unit tests passed).
 */
function plainRow(s: string): string {
	return s.replace(ANSI_RE, "").replace(/[\r\n]+$/, "");
}

// Wide-codepoint table copied from `displayWidth` in
// backend/src/services/glasses-relay.ts — a row's width in cells, not
// characters, decides whether it is full.
function isWideCodePoint(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals .. Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
		(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compat Forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
		(cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Symbols
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
	);
}

function displayWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		w += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
	}
	return w;
}

// RFC 3986's unreserved + reserved sets plus `%`. Anything outside them ends
// the URL, which is what stops a continuation run at a box-drawing border.
const URL_BODY = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
const URL_MATCH = new RegExp(`https?://[${URL_BODY}]+`, "g");
const URL_RUN = new RegExp(`^[${URL_BODY}]+`);

/**
 * Drop punctuation a terminal line ends with rather than the URL: prose
 * periods, and a closing bracket with no opener inside the URL itself.
 */
export function trimTrailingPunctuation(url: string): string {
	let out = url;
	for (;;) {
		const last = out.at(-1);
		if (last === undefined) break;
		if (".,;:!?'\"".includes(last)) {
			out = out.slice(0, -1);
			continue;
		}
		if (last === ")" && !out.includes("(")) {
			out = out.slice(0, -1);
			continue;
		}
		if (last === "]" && !out.includes("[")) {
			out = out.slice(0, -1);
			continue;
		}
		break;
	}
	return out;
}

/** Cheap pre-check so the common case (no URL on screen) costs one scan. */
export function viewportMayHaveUrl(lines: string[]): boolean {
	for (const line of lines) {
		if (line.includes("://")) return true;
	}
	return false;
}

/**
 * URLs visible in a viewport, in screen order, wrapped ones rejoined.
 *
 * `cols` is the pane width in cells — a row narrower than that ended on its
 * own and never continues.
 */
export function extractViewportUrls(
	lines: string[],
	cols: number,
	limit = 6,
): string[] {
	if (!viewportMayHaveUrl(lines)) return [];
	const plain = lines.map(plainRow);
	// Leading characters of a row already taken as the tail of a URL that
	// started above it, so a continuation is never also read as its own URL.
	const consumed = new Map<number, number>();
	const found: string[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < plain.length; i++) {
		const line = plain[i] ?? "";
		const from = consumed.get(i) ?? 0;
		if (from >= line.length) continue;

		URL_MATCH.lastIndex = 0;
		for (let m = URL_MATCH.exec(line); m !== null; m = URL_MATCH.exec(line)) {
			if (m.index < from) continue;
			let url = m[0];
			const endsRow = m.index + url.length >= line.length;
			if (endsRow && cols > 0 && displayWidth(line) >= cols) {
				for (let j = i + 1; j < plain.length; j++) {
					const next = plain[j] ?? "";
					const run = URL_RUN.exec(next)?.[0];
					if (!run) break;
					url += run;
					consumed.set(j, run.length);
					// The run stopped inside the row, so the URL stopped there too.
					if (run.length < next.length || displayWidth(next) < cols) break;
				}
			}
			const trimmed = trimTrailingPunctuation(url);
			// "https://" alone is a scheme, not a link.
			if (trimmed.length <= 8 || seen.has(trimmed)) continue;
			seen.add(trimmed);
			found.push(trimmed);
			if (found.length >= limit) return found;
		}
	}
	return found;
}

/** One piece of a message: prose, or a link. */
export type TextPart = { text: string } | { url: string };

/**
 * Split prose into text and links.
 *
 * Here rather than in a component, and on the same definition of a URL the
 * terminal uses: two answers to "where does this URL end" is how one of them
 * gets it wrong. Multibyte characters are outside `URL_BODY`, so a link
 * written straight against Japanese ends where the Japanese starts.
 */
export function splitLinks(text: string): TextPart[] {
	const parts: TextPart[] = [];
	let at = 0;
	const re = new RegExp(URL_MATCH.source, "g");
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		const url = trimTrailingPunctuation(m[0]);
		// "https://" alone is a scheme, not a link.
		if (url.length <= 8) continue;
		if (m.index > at) parts.push({ text: text.slice(at, m.index) });
		parts.push({ url });
		at = m.index + url.length;
	}
	if (at < text.length) parts.push({ text: text.slice(at) });
	return parts;
}
