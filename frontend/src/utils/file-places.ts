import { storageKey } from "./app-storage";

/**
 * Directories a person jumps back to in the file viewer: the ones they starred
 * and the ones they opened lately. Per browser, like the viewer's other
 * settings - a phone and a tablet are used for different things.
 */
const BOOKMARKS_KEY = storageKey("file-bookmarks");
const RECENT_KEY = storageKey("file-recent-dirs");
const RECENT_MAX = 8;

function readList(key: string): string[] {
	try {
		const raw = localStorage.getItem(key);
		const value = raw ? JSON.parse(raw) : [];
		return Array.isArray(value)
			? value.filter((v): v is string => typeof v === "string")
			: [];
	} catch {
		return [];
	}
}

function writeList(key: string, list: string[]) {
	try {
		localStorage.setItem(key, JSON.stringify(list));
	} catch {
		/* a full or blocked store only loses the shortcut */
	}
}

export function getBookmarks(): string[] {
	return readList(BOOKMARKS_KEY);
}

export function toggleBookmark(path: string): string[] {
	const list = getBookmarks();
	const next = list.includes(path)
		? list.filter((p) => p !== path)
		: [...list, path];
	writeList(BOOKMARKS_KEY, next);
	return next;
}

export function getRecentDirs(): string[] {
	return readList(RECENT_KEY);
}

export function addRecentDir(path: string): string[] {
	const next = [path, ...getRecentDirs().filter((p) => p !== path)].slice(
		0,
		RECENT_MAX,
	);
	writeList(RECENT_KEY, next);
	return next;
}

/** `/a/b/c` as the directories a breadcrumb steps through: `/a`, `/a/b`, `/a/b/c`. */
export function pathCrumbs(
	path: string,
	home: string | null,
): { label: string; path: string; isHome: boolean }[] {
	const crumbs: { label: string; path: string; isHome: boolean }[] = [];
	let rest = path;
	let prefix = "";
	if (home && (path === home || path.startsWith(`${home}/`))) {
		crumbs.push({ label: "~", path: home, isHome: true });
		rest = path.slice(home.length);
		prefix = home;
	}
	for (const part of rest.split("/")) {
		if (!part) continue;
		prefix = `${prefix}/${part}`;
		crumbs.push({ label: part, path: prefix, isHome: false });
	}
	return crumbs;
}

/** The home directory a path sits under, read off the path itself. */
export function homeOf(path: string): string | null {
	return /^\/(?:home|Users)\/[^/]+/.exec(path)?.[0] ?? null;
}

/** `~/x` and relative input made absolute against home and the current directory. */
export function expandPath(
	input: string,
	home: string | null,
	cwd: string,
): string {
	const raw = input.trim();
	let abs: string;
	if (raw === "~" || raw.startsWith("~/")) {
		abs = `${home ?? ""}${raw.slice(1)}`;
	} else if (raw.startsWith("/")) {
		abs = raw;
	} else {
		abs = `${cwd}/${raw}`;
	}
	const out: string[] = [];
	for (const part of abs.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
}

/** How a file is named in a prompt: relative to the session when it is inside it. */
export function promptPathFor(path: string, workingDir: string): string {
	if (path.startsWith(`${workingDir}/`)) {
		return `@${path.slice(workingDir.length + 1)}`;
	}
	return `@${path}`;
}
