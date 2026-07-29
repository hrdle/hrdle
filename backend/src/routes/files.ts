import { Hono } from 'hono';
import { readFile, mkdir, realpath, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { FileService } from '../services/file-service';
import { FileChangeTracker } from '../services/file-change-tracker';
import { HerdrService } from '../services/herdr';
import type { FileListResponse, FileReadResponse, FileChangesResponse, FileInfo, GitChangesResponse, GitDiffResponse, GitFileChange, GitChangeStatus } from '../../../shared/types';
import { TMP_PATHS } from '../../../shared/identity';

const fileService = new FileService();
const changeTracker = new FileChangeTracker();
const herdrService = new HerdrService();

/**
 * The client supplies `sessionWorkingDir` as the base for file access. It MUST
 * be the working directory of an actual live session/pane (or a directory
 * below one); otherwise a client could set base=/etc (or ~/.ssh, /) and the
 * only confinement check (requested path startsWith base) would happily read
 * or write arbitrary host files. We resolve the candidate against the
 * authoritative live-session list and compare realpaths so a symlinked base
 * can't smuggle an off-tree path. (#232)
 */
async function isAllowedSessionDir(sessionWorkingDir: string): Promise<boolean> {
  let target: string;
  try {
    target = await realpath(sessionWorkingDir);
  } catch {
    return false;
  }
  const sessions = await herdrService.listWorkspaces();
  for (const s of sessions) {
    for (const cand of [s.currentPath, ...(s.panes ?? []).map((p) => p.path)]) {
      if (!cand) continue;
      let base: string;
      try {
        base = await realpath(cand);
      } catch {
        continue;
      }
      if (target === base || target.startsWith(`${base}/`)) return true;
    }
  }
  return false;
}

export const files = new Hono();

/**
 * GET /files/list - List directory contents
 * Query params:
 *   - path: Directory path to list
 *   - sessionWorkingDir: Working directory of the session (for security)
 */
files.get('/list', async (c) => {
  const path = c.req.query('path');
  const sessionWorkingDir = c.req.query('sessionWorkingDir');

  if (!path || !sessionWorkingDir) {
    return c.json({ error: 'Missing path or sessionWorkingDir parameter' }, 400);
  }

  if (!(await isAllowedSessionDir(sessionWorkingDir))) {
    return c.json({ error: 'Access denied' }, 403);
  }

  try {
    const files = await fileService.listDirectory(path, sessionWorkingDir);
    const parentPath = fileService.getParentPath(path, sessionWorkingDir);

    const response: FileListResponse = {
      path,
      files,
      parentPath,
    };

    return c.json(response);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Access denied')) {
      return c.json({ error: 'Access denied' }, 403);
    }
    return c.json({ error: 'Failed to list directory' }, 500);
  }
});

/**
 * GET /files/read - Read file contents
 * Query params:
 *   - path: File path to read
 *   - sessionWorkingDir: Working directory of the session (for security)
 *   - maxSize: Optional max file size in bytes (default 1MB)
 */
files.get('/read', async (c) => {
  const path = c.req.query('path');
  const sessionWorkingDir = c.req.query('sessionWorkingDir');
  const maxSizeParam = c.req.query('maxSize');
  const maxSize = maxSizeParam ? parseInt(maxSizeParam, 10) : undefined;

  if (!path || !sessionWorkingDir) {
    return c.json({ error: 'Missing path or sessionWorkingDir parameter' }, 400);
  }

  if (!(await isAllowedSessionDir(sessionWorkingDir))) {
    return c.json({ error: 'Access denied' }, 403);
  }

  try {
    const file = await fileService.readFile(path, sessionWorkingDir, maxSize);

    const response: FileReadResponse = {
      file,
    };

    return c.json(response);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('Access denied')) {
        return c.json({ error: 'Access denied' }, 403);
      }
      if (error.message.includes('Cannot read directory')) {
        return c.json({ error: 'Cannot read directory as file' }, 400);
      }
    }
    return c.json({ error: 'Failed to read file' }, 500);
  }
});

/**
 * GET /files/changes/:sessionWorkingDir - Get changed files for a session
 * Path params:
 *   - sessionWorkingDir: URL-encoded working directory of the session
 */
files.get('/changes/:sessionWorkingDir', async (c) => {
  const sessionWorkingDir = decodeURIComponent(c.req.param('sessionWorkingDir'));

  if (!sessionWorkingDir) {
    return c.json({ error: 'Missing sessionWorkingDir parameter' }, 400);
  }

  if (!(await isAllowedSessionDir(sessionWorkingDir))) {
    return c.json({ error: 'Access denied' }, 403);
  }

  try {
    const changes = await changeTracker.getChangesForWorkingDir(sessionWorkingDir);

    const response: FileChangesResponse = {
      sessionId: sessionWorkingDir,
      changes,
    };

    return c.json(response);
  } catch (_error) {
    return c.json({ error: 'Failed to get changes' }, 500);
  }
});

/**
 * GET /files/git-changes/:workingDir - Get git-tracked changed files
 * Path params:
 *   - workingDir: URL-encoded working directory
 */
files.get('/git-changes/:workingDir', async (c) => {
  const workingDir = decodeURIComponent(c.req.param('workingDir'));

  if (!workingDir) {
    return c.json({ error: 'Missing workingDir parameter' }, 400);
  }

  if (!(await isAllowedSessionDir(workingDir))) {
    return c.json({ error: 'Access denied' }, 403);
  }

  try {
    // Get current branch
    const branchProc = Bun.spawn(['git', '-C', workingDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const branchOutput = await new Response(branchProc.stdout).text();
    await branchProc.exited;
    const branch = branchOutput.trim() || 'unknown';

    // Get git status
    const statusProc = Bun.spawn(['git', '-C', workingDir, 'status', '--porcelain'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const statusOutput = await new Response(statusProc.stdout).text();
    await statusProc.exited;

    const changes: GitFileChange[] = [];
    for (const line of statusOutput.split('\n')) {
      if (!line.trim()) continue;

      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.slice(3).trim();

      // Skip empty paths
      if (!filePath) continue;

      // Handle renamed files (e.g., "R  old -> new")
      const actualPath = filePath.includes(' -> ') ? filePath.split(' -> ')[1] : filePath;

      // Staged changes
      if (indexStatus !== ' ' && indexStatus !== '?') {
        let status: GitChangeStatus = 'M';
        if (indexStatus === 'A') status = 'A';
        else if (indexStatus === 'D') status = 'D';
        else if (indexStatus === 'R') status = 'R';
        else if (indexStatus === 'U') status = 'U';
        changes.push({ path: actualPath, status, staged: true });
      }

      // Unstaged changes
      if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
        // Don't add duplicate for same file if already added as staged
        const existingUnstaged = changes.find(ch => ch.path === actualPath && !ch.staged);
        if (!existingUnstaged) {
          let status: GitChangeStatus = 'M';
          if (workTreeStatus === 'D') status = 'D';
          else if (workTreeStatus === 'U') status = 'U';
          changes.push({ path: actualPath, status, staged: false });
        }
      }

      // Untracked files
      if (indexStatus === '?' && workTreeStatus === '?') {
        changes.push({ path: actualPath, status: '??', staged: false });
      }
    }

    const response: GitChangesResponse = { workingDir, changes, branch };
    return c.json(response);
  } catch (error) {
    console.error('Git changes error:', error);
    return c.json({ error: 'Failed to get git changes' }, 500);
  }
});

/**
 * GET /files/git-diff/:workingDir - Get unified diff for a file
 * Path params:
 *   - workingDir: URL-encoded working directory
 * Query params:
 *   - path: File path (relative to workingDir)
 *   - staged: "true" for staged diff
 */
files.get('/git-diff/:workingDir', async (c) => {
  const workingDir = decodeURIComponent(c.req.param('workingDir'));
  const filePath = c.req.query('path');
  const staged = c.req.query('staged') === 'true';

  if (!workingDir || !filePath) {
    return c.json({ error: 'Missing workingDir or path parameter' }, 400);
  }

  if (!(await isAllowedSessionDir(workingDir))) {
    return c.json({ error: 'Access denied' }, 403);
  }

  try {
    const args = ['git', '-C', workingDir, 'diff'];
    if (staged) {
      args.push('--cached');
    }
    args.push('--', filePath);

    const proc = Bun.spawn(args, {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const diffOutput = await new Response(proc.stdout).text();
    await proc.exited;

    // If no diff output (e.g., untracked file), try to read the file content
    if (!diffOutput.trim()) {
      // For untracked files, generate a "new file" diff
      try {
        const fullPath = join(workingDir, filePath);
        // Confine the fallback read to the (session-validated) workingDir so a
        // relative path like "../../etc/passwd" can't escape it
        const realFullPath = await realpath(fullPath);
        const realWorkingDir = await realpath(workingDir);
        if (realFullPath !== realWorkingDir && !realFullPath.startsWith(`${realWorkingDir}/`)) {
          return c.json({ error: 'Access denied' }, 403);
        }
        const content = await readFile(realFullPath, 'utf-8');
        const lines = content.split('\n');
        const fakeDiff = [
          `--- /dev/null`,
          `+++ b/${filePath}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map(line => `+${line}`),
        ].join('\n');

        const response: GitDiffResponse = { diff: fakeDiff, path: filePath };
        return c.json(response);
      } catch {
        const response: GitDiffResponse = { diff: '', path: filePath };
        return c.json(response);
      }
    }

    const response: GitDiffResponse = { diff: diffOutput, path: filePath };
    return c.json(response);
  } catch (error) {
    console.error('Git diff error:', error);
    return c.json({ error: 'Failed to get git diff' }, 500);
  }
});

/**
 * GET /files/language - Get language identifier for syntax highlighting
 * Query params:
 *   - path: File path
 */
files.get('/language', async (c) => {
  const path = c.req.query('path');

  if (!path) {
    return c.json({ error: 'Missing path parameter' }, 400);
  }

  const language = fileService.getLanguageFromPath(path);
  const isImage = fileService.isImage(path);
  const isText = fileService.isTextFile(path);

  return c.json({ language, isImage, isText });
});

/**
 * GET /files/images/:filename - Serve conversation images
 * Only serves images from /tmp/hrdle-images/ for security
 */
const IMAGES_DIR = TMP_PATHS.imagesDir;

files.get('/images/:filename', async (c) => {
  const filename = c.req.param('filename');

  // Security: only allow alphanumeric, dash, dot for filename
  if (!filename || !/^[\w\-.]+\.(png|jpg|jpeg|gif|webp)$/i.test(filename)) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const filePath = join(IMAGES_DIR, basename(filename));

  try {
    const data = await readFile(filePath);
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };

    return new Response(data, {
      headers: {
        'Content-Type': mimeTypes[ext || 'png'] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return c.json({ error: 'Image not found' }, 404);
  }
});

/**
 * GET /files/browse - Browse directories (session-independent)
 * Query params:
 *   - path: Directory path to browse (optional, defaults to home)
 * Security: Only allows access within home directory
 */
files.get('/browse', async (c) => {
  const requestedPath = c.req.query('path') || homedir();
  const homeDir = homedir();

  try {
    // Resolve paths to prevent traversal attacks
    const resolvedHome = await realpath(homeDir);
    let resolvedPath: string;

    try {
      resolvedPath = await realpath(requestedPath);
    } catch {
      // Path doesn't exist, return error
      return c.json({ error: 'Path not found' }, 404);
    }

    // Security: ensure path is within home directory
    if (!resolvedPath.startsWith(`${resolvedHome}/`) && resolvedPath !== resolvedHome) {
      return c.json({ error: 'Access denied: path outside home directory' }, 403);
    }

    // List only directories
    const allFiles = await fileService.listDirectory(resolvedPath, homeDir);
    const directories: FileInfo[] = allFiles.filter(f => f.type === 'directory');

    // Get parent path (only if within home)
    let parentPath: string | null = null;
    const parent = join(resolvedPath, '..');
    try {
      const resolvedParent = await realpath(parent);
      if (resolvedParent.startsWith(resolvedHome) || resolvedParent === resolvedHome) {
        parentPath = resolvedParent;
      }
    } catch {
      // Ignore parent resolution errors
    }

    return c.json({
      path: resolvedPath,
      files: directories,
      parentPath,
    } as FileListResponse);
  } catch (error) {
    console.error('Browse error:', error);
    return c.json({ error: 'Failed to browse directory' }, 500);
  }
});

/**
 * POST /files/mkdir - Create a new directory
 * Body: { path: string }
 * Security: Only allows creation within home directory
 */
files.post('/mkdir', async (c) => {
  const body = await c.req.json<{ path: string }>();
  const requestedPath = body?.path;

  if (!requestedPath) {
    return c.json({ error: 'Missing path parameter' }, 400);
  }

  const homeDir = homedir();

  try {
    const resolvedHome = await realpath(homeDir);

    // Validate parent directory exists and is within home
    const parentDir = join(requestedPath, '..');
    let resolvedParent: string;

    try {
      resolvedParent = await realpath(parentDir);
    } catch {
      return c.json({ error: 'Parent directory not found' }, 404);
    }

    if (!resolvedParent.startsWith(`${resolvedHome}/`) && resolvedParent !== resolvedHome) {
      return c.json({ error: 'Access denied: path outside home directory' }, 403);
    }

    // Create directory
    await mkdir(requestedPath, { recursive: false });

    // Return the created path
    const resolvedPath = await realpath(requestedPath);
    return c.json({ path: resolvedPath, success: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes('EEXIST')) {
      return c.json({ error: 'Directory already exists' }, 409);
    }
    console.error('Mkdir error:', error);
    return c.json({ error: 'Failed to create directory' }, 500);
  }
});

/**
 * GET /files/raw - Serve a file inline (for <img>/<video> rendering, etc.)
 * Query params:
 *   - path: File path
 *   - sessionWorkingDir: Working directory of the session (for security)
 *
 * Uses Bun.file() for streaming. No size limit. Content-Type inferred from
 * the file service's known mime mapping.
 */
files.get('/raw', async (c) => {
  const path = c.req.query('path');
  const sessionWorkingDir = c.req.query('sessionWorkingDir');

  if (!path || !sessionWorkingDir) {
    return c.json({ error: 'Missing path or sessionWorkingDir parameter' }, 400);
  }

  if (!(await isAllowedSessionDir(sessionWorkingDir))) {
    return c.json({ error: 'Access denied' }, 403);
  }

  try {
    const validPath = await fileService.validatePath(path, sessionWorkingDir);
    if (!validPath) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const stats = await stat(validPath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot serve a directory' }, 400);
    }

    const file = Bun.file(validPath);
    const mime = file.type || 'application/octet-stream';
    const totalSize = stats.size;

    // Support Range requests for video/audio seeking and progressive playback.
    // Validate and clamp: Bun.file().slice happily returns a BunFile whose
    // declared .size is the requested chunk but streams fewer bytes if the
    // range goes past EOF, so an un-clamped Content-Length would lie and
    // keep-alive clients would hang waiting for promised bytes. #253
    const rangeHeader = c.req.header('Range');
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const start = Number.parseInt(match[1] as string, 10);
        const requestedEnd = match[2]
          ? Number.parseInt(match[2], 10)
          : totalSize - 1;
        const unsatisfiable =
          !Number.isFinite(start) ||
          !Number.isFinite(requestedEnd) ||
          start < 0 ||
          start >= totalSize ||
          start > requestedEnd;
        if (unsatisfiable) {
          return new Response(null, {
            status: 416,
            headers: {
              'Content-Range': `bytes */${totalSize}`,
              'Accept-Ranges': 'bytes',
            },
          });
        }
        const end = Math.min(requestedEnd, totalSize - 1);
        const chunkSize = end - start + 1;
        // Materialise the slice into an ArrayBuffer. Passing the BunFile slice
        // directly to Response makes Bun's HTTP layer fall back to chunked
        // encoding *and* stream the entire underlying file (the slice bound is
        // dropped at the transport layer), so Content-Length doesn't match the
        // body and the response is unusable for video seeking. Buffering the
        // chunk (capped at totalSize - start by the clamp above) gives Bun a
        // sized body it streams correctly. #253
        const chunk = await file.slice(start, end + 1).arrayBuffer();
        return new Response(chunk, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=300',
          },
        });
      }
    }

    return new Response(file, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (error) {
    console.error('Raw file error:', error);
    return c.json({ error: 'Failed to serve file' }, 500);
  }
});

/**
 * GET /files/download - Download a file as binary attachment (streamed)
 * Query params:
 *   - path: File path to download
 *   - sessionWorkingDir: Working directory of the session (for security)
 *
 * Uses Bun.file() which streams from disk — no size limit, low memory.
 */
files.get('/download', async (c) => {
  const path = c.req.query('path');
  const sessionWorkingDir = c.req.query('sessionWorkingDir');

  if (!path || !sessionWorkingDir) {
    return c.json({ error: 'Missing path or sessionWorkingDir parameter' }, 400);
  }

  if (!(await isAllowedSessionDir(sessionWorkingDir))) {
    return c.json({ error: 'Access denied' }, 403);
  }

  try {
    const validPath = await fileService.validatePath(path, sessionWorkingDir);
    if (!validPath) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const stats = await stat(validPath);
    if (stats.isDirectory()) {
      return c.json({ error: 'Cannot download a directory' }, 400);
    }

    const filename = basename(validPath);
    const asciiName = filename.replace(/[^\x20-\x7e]/g, '_');
    const encodedName = encodeURIComponent(filename);

    // Bun.file() returns a BunFile that streams from disk when used as a Response body.
    const file = Bun.file(validPath);
    return new Response(file, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stats.size),
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Download error:', error);
    return c.json({ error: 'Failed to download file' }, 500);
  }
});

/**
 * POST /files/upload - Upload file(s) into a session-scoped directory
 * Body (multipart/form-data):
 *   - file: File(s) to upload (repeatable)
 *   - path: Destination directory
 *   - sessionWorkingDir: Working directory of the session (for security)
 *
 * Uses Bun.write() which streams from the incoming File — no size limit,
 * low memory.
 */
files.post('/upload', async (c) => {
  try {
    const formData = await c.req.formData();
    const destPath = formData.get('path');
    const sessionWorkingDir = formData.get('sessionWorkingDir');

    if (typeof destPath !== 'string' || typeof sessionWorkingDir !== 'string') {
      return c.json({ error: 'Missing path or sessionWorkingDir' }, 400);
    }

    if (!(await isAllowedSessionDir(sessionWorkingDir))) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const validDir = await fileService.validatePath(destPath, sessionWorkingDir);
    if (!validDir) {
      return c.json({ error: 'Access denied' }, 403);
    }
    const dirStat = await stat(validDir);
    if (!dirStat.isDirectory()) {
      return c.json({ error: 'Destination is not a directory' }, 400);
    }

    const fileEntries = formData.getAll('file');
    if (fileEntries.length === 0) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const saved: Array<{ name: string; size: number; path: string }> = [];
    for (const entry of fileEntries) {
      if (!(entry instanceof File)) continue;

      const safeName = basename(entry.name);
      if (!safeName || safeName === '.' || safeName === '..') {
        return c.json({ error: `Invalid filename: ${entry.name}` }, 400);
      }

      const targetPath = join(validDir, safeName);
      // Defense-in-depth against symlinks pointing outside the session dir.
      const validTarget = await fileService.validatePathWithParent(targetPath, sessionWorkingDir);
      if (!validTarget) {
        return c.json({ error: `Access denied for ${safeName}` }, 403);
      }

      // Bun.write accepts a File/Blob and streams it to disk.
      await Bun.write(validTarget, entry);
      saved.push({ name: safeName, size: entry.size, path: validTarget });
    }

    return c.json({ success: true, files: saved });
  } catch (error) {
    console.error('Upload error:', error);
    return c.json({ error: 'Failed to upload file' }, 500);
  }
});
