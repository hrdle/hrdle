import { describe, expect, test } from "bun:test";
import { TMP_PATHS } from "../../../shared/identity";
import { bracketedPaste, imagePastePayload } from "./terminal-paste";

describe("bracketedPaste", () => {
	test("wraps the text in DECSET 2004 markers", () => {
		expect(bracketedPaste("hello")).toBe("\x1b[200~hello\x1b[201~");
	});

	test("carries newlines, which is the point of using it", () => {
		expect(bracketedPaste("a\nb")).toBe("\x1b[200~a\nb\x1b[201~");
	});
});

describe("imagePastePayload", () => {
	const path = `${TMP_PATHS.imagesDir}/1785535391131-54a7a3971872a527.jpg`;

	test("arrives as a paste, which is what turns it into [Image #1]", () => {
		// Typed in as keystrokes the path stays a path in the prompt. Verified
		// against Claude Code 2.1.220 on a live pane.
		expect(imagePastePayload(path)).toBe(`\x1b[200~${path}\x1b[201~ `);
	});

	test("the separating space is outside the markers, not part of the filename", () => {
		const payload = imagePastePayload(path);
		const pasted = payload.slice(
			payload.indexOf("\x1b[200~") + 6,
			payload.indexOf("\x1b[201~"),
		);
		expect(pasted).toBe(path);
		expect(payload.endsWith("\x1b[201~ ")).toBe(true);
	});
});
