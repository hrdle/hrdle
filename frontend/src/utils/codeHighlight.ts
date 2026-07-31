import hljs from "highlight.js";

/**
 * Syntax highlighting for the conversation.
 *
 * The file viewer has highlighted code since it existed; the transcript showed
 * the same files as one flat grey. Both now go through highlight.js, which is
 * already in the bundle, so this costs nothing but the parse.
 *
 * Colors are NOT highlight.js's own theme (the viewer imports github-dark,
 * which is dark-only and cold): the emitted `hljs-*` classes are re-coloured
 * against the conversation palette in index.css, scoped to `.cv-code`.
 */

/**
 * Above this, highlighting is skipped.
 *
 * A tool result can be a whole file, and every visible block re-parses on
 * render. The cap is generous for code a person actually reads and cheap
 * insurance against a 2MB log arriving in the middle of a scroll.
 */
const MAX_HIGHLIGHT_CHARS = 40_000;

/**
 * Extension to language.
 *
 * Fenced blocks name their language; tool results never do — the only clue is
 * the path the call was given. Names highlight.js already knows are left to
 * it (`getLanguage` accepts aliases), so this table only carries what a bare
 * extension would otherwise lose.
 */
const BY_EXTENSION: Record<string, string> = {
	bash: "bash",
	c: "c",
	cc: "cpp",
	cjs: "javascript",
	conf: "ini",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	dart: "dart",
	ex: "elixir",
	exs: "elixir",
	go: "go",
	h: "c",
	hpp: "cpp",
	hs: "haskell",
	htm: "xml",
	html: "xml",
	ini: "ini",
	java: "java",
	js: "javascript",
	json: "json",
	jsonc: "json",
	jsx: "javascript",
	kt: "kotlin",
	lua: "lua",
	md: "markdown",
	mdx: "markdown",
	mjs: "javascript",
	mts: "typescript",
	php: "php",
	pl: "perl",
	py: "python",
	r: "r",
	rb: "ruby",
	rs: "rust",
	scala: "scala",
	scss: "scss",
	sh: "bash",
	sql: "sql",
	svg: "xml",
	swift: "swift",
	toml: "ini",
	ts: "typescript",
	tsx: "typescript",
	vim: "vim",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml",
	zsh: "bash",
};

/** Files whose whole name is the type. */
const BY_FILENAME: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
	gemfile: "ruby",
	rakefile: "ruby",
};

/** The language of the file a tool call was pointed at, if we can tell. */
export function languageForPath(path: string | undefined | null): string | null {
	if (typeof path !== "string" || !path) return null;
	const base = path.split("/").pop()?.toLowerCase() ?? "";
	if (!base) return null;
	const byName = BY_FILENAME[base];
	if (byName) return byName;
	const dot = base.lastIndexOf(".");
	if (dot < 0) return null;
	return BY_EXTENSION[base.slice(dot + 1)] ?? null;
}

/**
 * Highlighted HTML, or null when the caller should render the text as text.
 *
 * Null rather than a plain-text string on purpose: the result goes through
 * `dangerouslySetInnerHTML`, and the only thing that may take that path is
 * output highlight.js escaped itself. An unknown language returning "the
 * source, unescaped" is how a file full of `<script>` gets rendered.
 */
export function highlightToHtml(
	code: string,
	language: string | null | undefined,
): string | null {
	if (!language || !code) return null;
	if (code.length > MAX_HIGHLIGHT_CHARS) return null;
	if (!hljs.getLanguage(language)) return null;
	try {
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	} catch {
		return null;
	}
}

/**
 * Language for a tool *result*, given the path the call named.
 *
 * A single-line result is a status message -- "File created successfully at
 * ..." -- and colouring that as TypeScript tints scattered words in an English
 * sentence. File content, which is what the language would help with, always
 * has line breaks in it.
 */
export function languageForOutput(
	path: string | undefined | null,
	output: string,
): string | null {
	if (!output.includes("\n")) return null;
	return languageForPath(path);
}

/** Language named by a markdown fence (`className="language-ts"`). */
export function languageFromClassName(
	className: string | undefined,
): string | null {
	const match = className?.match(/language-([\w+-]+)/);
	if (!match) return null;
	const name = match[1].toLowerCase();
	return BY_EXTENSION[name] ?? name;
}
