/**
 * The one line that says what a tool call is doing, shown next to its name in
 * the conversation.
 *
 * Every agent invents its own input shape, so this reads by field rather than
 * by tool name wherever it can. The order is what a reader would want first:
 * an author's own description, then the thing being acted on (a file, a
 * pattern, a query, a URL), then the instruction given.
 *
 * The last resort matters more than it looks. Left with nothing, the row shows
 * a bare tool name and every call of that tool looks identical — which is what
 * WebSearch and ToolSearch did before `query` was in this list. Rather than
 * add a field per tool forever, an unrecognised input falls back to its first
 * short string value, which for most tools is the thing it was given.
 */

const MAX = 60;

/** Field names never worth showing: identifiers, flags, formatting knobs. */
const SKIP = new Set([
	"id",
	"uuid",
	"session_id",
	"sessionId",
	"tool_use_id",
	"toolUseId",
	"type",
	"format",
	"encoding",
	"model",
	"agent",
	"subagent_type",
]);

function oneLine(text: string): string {
	const line = text.trim().split("\n")[0].trim();
	return line.length > MAX ? `${line.slice(0, MAX)}…` : line;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function getToolSummary(input: Record<string, unknown>): string {
	// An explicit description (Bash, and agents that copy it) beats everything:
	// it was written to be read.
	const description = str(input.description);
	if (description) return oneLine(description);

	// Grep/Glob, then search tools (WebSearch, ToolSearch, most MCP lookups).
	// Ahead of the file block deliberately: a scoped Grep carries a `path` as
	// well, and reading that first made the row name the directory it looked in
	// rather than the thing it was looking for.
	const pattern = str(input.pattern) ?? str(input.query);
	if (pattern) return oneLine(pattern);

	// File-based tools: the basename is what identifies the call, and the
	// directory is the part that pushes it off the edge of a phone.
	const filePath =
		str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
	if (filePath) {
		const parts = filePath.split("/");
		return oneLine(parts[parts.length - 1] || filePath);
	}

	// Fetchers: the address is shorter and more identifying than the question.
	const url = str(input.url);
	if (url) return oneLine(url);

	const command = str(input.command);
	if (command) return oneLine(command);

	const prompt = str(input.prompt);
	if (prompt) return oneLine(prompt);

	// Anything else: the first short string it was given. A tool nobody
	// anticipated still says something about itself.
	for (const [key, value] of Object.entries(input)) {
		if (SKIP.has(key)) continue;
		const text = str(value);
		if (!text) continue;
		if (text.includes("\n")) continue;
		if (text.length > 120) continue;
		return oneLine(text);
	}

	return "";
}
