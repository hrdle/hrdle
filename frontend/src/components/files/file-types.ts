// File-type detection by extension, shared across the file viewer components
// (FileViewer / FileContentView / ChangesView).

const IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".bmp",
	".svg",
]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

const HTML_EXTENSIONS = new Set([".html", ".htm"]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogg", ".mov", ".m4v"]);

// 3D model formats the file viewer can render (see StlViewer)
const MODEL_EXTENSIONS = new Set([".stl"]);

const AUDIO_EXTENSIONS = new Set([
	".mp3",
	".wav",
	".ogg",
	".m4a",
	".aac",
	".flac",
	".wma",
]);

function extOf(path: string): string | undefined {
	return path.toLowerCase().match(/\.[^.]+$/)?.[0];
}

export function isImageFile(path: string): boolean {
	const ext = extOf(path);
	return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

export function isMarkdownFile(path: string): boolean {
	const ext = extOf(path);
	return ext ? MARKDOWN_EXTENSIONS.has(ext) : false;
}

export function isHtmlFile(path: string): boolean {
	const ext = extOf(path);
	return ext ? HTML_EXTENSIONS.has(ext) : false;
}

export function isVideoFile(path: string): boolean {
	const ext = extOf(path);
	return ext ? VIDEO_EXTENSIONS.has(ext) : false;
}

function isAudioFile(path: string): boolean {
	const ext = extOf(path);
	return ext ? AUDIO_EXTENSIONS.has(ext) : false;
}

export function isModelFile(path: string): boolean {
	const ext = extOf(path);
	return ext ? MODEL_EXTENSIONS.has(ext) : false;
}

export function isMediaFile(path: string): boolean {
	return isVideoFile(path) || isAudioFile(path);
}

export function getFileName(path: string): string {
	return path.split("/").pop() || path;
}
