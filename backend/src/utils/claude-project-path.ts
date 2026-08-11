/**
 * Convert a working directory to the per-project bucket name Claude Code uses
 * under `~/.claude/projects/<bucket>/`. Claude collapses BOTH path separators
 * and dots in the project name (e.g. `github.com/m0a/hrdle` →
 * `github-com-m0a-hrdle`), so a slash-only normalisation misses every path
 * containing a dot — silently breaking metrics, file-change tracking,
 * conversation watching, and history grouping for those projects.
 */
export function claudeProjectDirName(workingDir: string): string {
	return workingDir.replace(/[/.]/g, '-');
}
