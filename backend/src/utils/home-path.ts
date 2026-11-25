/**
 * A path with its home directory written as `~/`, for showing a project. The
 * home is matched by shape rather than read from `homedir()`, because the
 * paths come from transcripts that may have been written by another user or
 * on another machine; `/Users/` is where macOS puts it.
 */
export function homeShortPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+\//, '~/');
}
