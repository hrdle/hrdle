import { readdir, stat, readFile, realpath } from 'node:fs/promises';
import { join, dirname, extname, basename } from 'node:path';
import type { FileInfo, FileContent, FileType } from '../../../shared/types';

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1MB

// MIME type mappings
const MIME_TYPES: Record<string, string> = {
  // Text/Code
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/scss',
  '.less': 'text/less',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.xml': 'text/xml',
  '.svg': 'image/svg+xml',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.java': 'text/x-java',
  '.kt': 'text/x-kotlin',
  '.swift': 'text/x-swift',
  '.sql': 'text/x-sql',
  '.graphql': 'text/x-graphql',
  '.dockerfile': 'text/x-dockerfile',
  '.gitignore': 'text/plain',
  '.env': 'text/plain',
  '.lock': 'text/plain',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  // 3D models
  '.stl': 'model/stl',
  // Binary (for reference)
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

// Text file extensions (for content reading)
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.html', '.css',
  '.scss', '.less', '.yaml', '.yml', '.toml', '.xml', '.svg', '.sh',
  '.bash', '.zsh', '.py', '.rb', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
  '.java', '.kt', '.swift', '.sql', '.graphql', '.dockerfile', '.gitignore',
  '.env', '.lock', '.vue', '.svelte', '.astro',
  '.zig', '.zon', '.nim', '.dart', '.lua', '.r', '.R', '.pl', '.pm',
  '.ex', '.exs', '.erl', '.hrl', '.hs', '.ml', '.mli', '.clj', '.cljs',
  '.scala', '.groovy', '.tf', '.hcl', '.proto', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.log', '.diff', '.patch', '.makefile', '.cmake',
]);

// Image extensions
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
]);

// Media extensions (served via /files/raw, not read into memory)
const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.webm', '.ogg', '.mov', '.m4v',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.wma',
]);

// 3D model extensions. Also served via /files/raw: the viewer needs the whole
// mesh, and an ASCII STL would otherwise come back as text truncated at the 1MB
// read limit - a partial mesh renders as a plausible-looking model with pieces
// missing rather than as an error.
const MODEL_EXTENSIONS = new Set(['.stl']);

export class FileService {
  /**
   * Validate that the requested path is within the allowed base directory.
   * Returns the resolved path if valid, null otherwise.
   */
  async validatePath(requested: string, allowedBase: string): Promise<string | null> {
    try {
      // Resolve to absolute paths
      const resolvedBase = await realpath(allowedBase);
      const resolvedRequested = await realpath(requested);

      // Check if requested path is within allowed base
      if (!resolvedRequested.startsWith(`${resolvedBase}/`) && resolvedRequested !== resolvedBase) {
        return null;
      }

      return resolvedRequested;
    } catch (_error) {
      // Path doesn't exist or can't be accessed
      return null;
    }
  }

  /**
   * Validate a path that might not exist yet (for parent directory check).
   */
  async validatePathWithParent(requested: string, allowedBase: string): Promise<string | null> {
    try {
      const resolvedBase = await realpath(allowedBase);

      // First try to resolve the full path
      try {
        const resolvedRequested = await realpath(requested);
        if (!resolvedRequested.startsWith(`${resolvedBase}/`) && resolvedRequested !== resolvedBase) {
          return null;
        }
        return resolvedRequested;
      } catch {
        // Path doesn't exist, check parent
        const parent = dirname(requested);
        const resolvedParent = await realpath(parent);

        if (!resolvedParent.startsWith(`${resolvedBase}/`) && resolvedParent !== resolvedBase) {
          return null;
        }

        // Return the normalized path (parent + basename)
        return join(resolvedParent, basename(requested));
      }
    } catch {
      return null;
    }
  }

  /**
   * List directory contents.
   */
  async listDirectory(path: string, allowedBase: string): Promise<FileInfo[]> {
    const validPath = await this.validatePath(path, allowedBase);
    if (!validPath) {
      throw new Error('Access denied: path outside allowed directory');
    }

    const entries = await readdir(validPath, { withFileTypes: true });
    const files: FileInfo[] = [];

    for (const entry of entries) {
      const fullPath = join(validPath, entry.name);

      try {
        const stats = await stat(fullPath);
        const ext = extname(entry.name).toLowerCase();

        let fileType: FileType = 'file';
        if (entry.isDirectory()) {
          fileType = 'directory';
        } else if (entry.isSymbolicLink()) {
          fileType = 'symlink';
        }

        files.push({
          name: entry.name,
          path: fullPath,
          type: fileType,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          isHidden: entry.name.startsWith('.'),
          extension: ext || undefined,
        });
      } catch {
        // Skip files we can't stat (broken symlinks, etc.)
      }
    }

    // Sort: directories first, then by name
    files.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    return files;
  }

  /**
   * Read file contents.
   */
  async readFile(
    path: string,
    allowedBase: string,
    maxSize: number = DEFAULT_MAX_FILE_SIZE
  ): Promise<FileContent> {
    const validPath = await this.validatePath(path, allowedBase);
    if (!validPath) {
      throw new Error('Access denied: path outside allowed directory');
    }

    const stats = await stat(validPath);
    if (stats.isDirectory()) {
      throw new Error('Cannot read directory as file');
    }

    const ext = extname(validPath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    const knownText = TEXT_EXTENSIONS.has(ext) || this.isTextMime(mimeType);
    const isImage = IMAGE_EXTENSIONS.has(ext);

    // Images, media and 3D models are served via the streaming /files/raw
    // endpoint. Skip content loading to avoid wasting memory on large files.
    if (isImage || MEDIA_EXTENSIONS.has(ext) || MODEL_EXTENSIONS.has(ext)) {
      return {
        path: validPath,
        content: '',
        encoding: 'base64',
        mimeType,
        size: stats.size,
        truncated: false,
      };
    }

    const truncated = stats.size > maxSize;
    const readSize = truncated ? maxSize : stats.size;

    // Read file
    const buffer = await readFile(validPath);
    const contentBuffer = truncated ? buffer.subarray(0, readSize) : buffer;

    // Unknown extensions: try to decode as text if buffer looks textual
    const isText = knownText || this.looksLikeText(contentBuffer);

    let content: string;
    let encoding: 'utf-8' | 'base64';

    if (isText) {
      content = contentBuffer.toString('utf-8');
      encoding = 'utf-8';
    } else {
      // Binary file - return as base64
      content = contentBuffer.toString('base64');
      encoding = 'base64';
    }

    return {
      path: validPath,
      content,
      encoding,
      mimeType,
      size: stats.size,
      truncated,
    };
  }

  /**
   * Get parent directory path.
   */
  getParentPath(path: string, allowedBase: string): string | null {
    const parent = dirname(path);
    // Don't go above allowed base
    if (parent === path || !parent.startsWith(allowedBase)) {
      return null;
    }
    return parent;
  }

  /**
   * Check if MIME type is text-based.
   */
  private isTextMime(mime: string): boolean {
    return mime.startsWith('text/') || mime === 'application/json';
  }

  /**
   * Heuristic: treat buffer as text if it contains no NUL bytes and
   * the proportion of non-printable control bytes is low.
   * Used to render unknown-extension files as text when possible.
   */
  private looksLikeText(buf: Buffer, maxCheck = 8192): boolean {
    const len = Math.min(buf.length, maxCheck);
    if (len === 0) return true;
    let nonText = 0;
    for (let i = 0; i < len; i++) {
      const b = buf[i];
      if (b === 0) return false;
      // Allow tab(9), LF(10), CR(13), ESC(27); flag other C0 controls
      if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 27) {
        nonText++;
      }
    }
    return nonText / len < 0.3;
  }

  /**
   * Get language identifier for syntax highlighting.
   */
  getLanguageFromPath(path: string): string {
    const ext = extname(path).toLowerCase();
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'tsx',
      '.js': 'javascript',
      '.jsx': 'jsx',
      '.json': 'json',
      '.md': 'markdown',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.less': 'less',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.toml': 'toml',
      '.xml': 'xml',
      '.svg': 'xml',
      '.sh': 'bash',
      '.bash': 'bash',
      '.zsh': 'bash',
      '.py': 'python',
      '.rb': 'ruby',
      '.go': 'go',
      '.rs': 'rust',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.java': 'java',
      '.kt': 'kotlin',
      '.swift': 'swift',
      '.sql': 'sql',
      '.graphql': 'graphql',
      '.dockerfile': 'dockerfile',
      '.vue': 'vue',
      '.svelte': 'svelte',
      '.zig': 'zig',
      '.nim': 'nim',
      '.dart': 'dart',
      '.lua': 'lua',
      '.r': 'r',
      '.pl': 'perl',
      '.ex': 'elixir',
      '.exs': 'elixir',
      '.erl': 'erlang',
      '.hs': 'haskell',
      '.ml': 'ocaml',
      '.clj': 'clojure',
      '.scala': 'scala',
      '.groovy': 'groovy',
      '.tf': 'hcl',
      '.hcl': 'hcl',
      '.proto': 'protobuf',
      '.ini': 'ini',
      '.diff': 'diff',
      '.makefile': 'makefile',
      '.cmake': 'cmake',
    };
    return languageMap[ext] || languageMap[basename(path).toLowerCase()] || 'plaintext';
  }

  /**
   * Check if file is an image.
   */
  isImage(path: string): boolean {
    const ext = extname(path).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  }

  /**
   * Check if file is text-based.
   */
  isTextFile(path: string): boolean {
    const ext = extname(path).toLowerCase();
    return TEXT_EXTENSIONS.has(ext);
  }
}
