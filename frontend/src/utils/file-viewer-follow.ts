/**
 * Whether an open file browser should rebind to a directory.
 *
 * Extracted from DesktopLayout so the rule can be unit-tested away from the
 * component: the panel keeps one mounted viewer per directory, and the only
 * thing that decides which of them is on screen is `activeFileViewerDir`.
 */
export function shouldFollowSessionDir(
	/** The directory the newly active session is in. */
	dir: string | undefined,
	/** The directory the panel is currently bound to, if any. */
	activeDir: string | null,
	/** Directories whose viewer is open rather than dismissed. */
	openDirs: ReadonlySet<string>,
): boolean {
	if (!dir) return false;
	// Nothing on screen to follow. Switching sessions is not a reason to open
	// a file browser nobody asked for.
	if (!activeDir || !openDirs.has(activeDir)) return false;
	return dir !== activeDir;
}
