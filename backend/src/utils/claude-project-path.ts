/**
 * Convert a working directory to the per-project bucket name Claude Code uses
 * under `~/.claude/projects/<bucket>/`.
 *
 * Claude Code replaces every character outside `[a-zA-Z0-9]` with a dash, so a
 * normalisation that only collapses slashes and dots misses underscores and
 * non-ASCII alike, and a session in such a directory never matches its own
 * bucket - the lookup then falls through to scanning every project directory,
 * on each session push. Measured against Claude Code 2.1.327:
 * `/tmp/probe_ja<2 kanji><emoji>x` becomes `-tmp-probe-ja----x`.
 *
 * The missing `u` flag is deliberate, and is what produces the four dashes
 * above: an astral character is two UTF-16 code units and Claude Code replaces
 * each of them. With `/u` it would be one dash and the bucket would not match.
 */
export function claudeProjectDirName(workingDir: string): string {
	return workingDir.replace(/[^a-zA-Z0-9]/g, '-');
}
