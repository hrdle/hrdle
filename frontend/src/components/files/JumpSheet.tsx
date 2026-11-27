import { Clock, Folder, Home, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileInfo } from "../../../../shared/types";
import { authFetch } from "../../services/api";
import { expandPath } from "../../utils/file-places";
import { toHomeShortPath } from "../../utils/path";

export interface SessionPlace {
	name: string;
	path: string;
}

interface JumpSheetProps {
	currentPath: string;
	workingDir: string;
	otherSessions: SessionPlace[];
	bookmarks: string[];
	recent: string[];
	filesApiBase: string;
	/** The server's home directory, which `~` stands for. */
	home: string | null;
	onNavigate: (path: string) => void;
	onClose: () => void;
}

const SUGGEST_MAX = 6;

/**
 * Where to go next, from anywhere: a typed path with completion, this
 * session's directory, the other sessions' directories, bookmarks and the
 * directories opened lately. A phone has no address bar to type a path into
 * and no Finder to drag one from, so this is the way out of the session's tree.
 */
export function JumpSheet({
	currentPath,
	workingDir,
	otherSessions,
	bookmarks,
	recent,
	filesApiBase,
	home,
	onNavigate,
	onClose,
}: JumpSheetProps) {
	const { t } = useTranslation();
	const [input, setInput] = useState(() => `${toHomeShortPath(currentPath)}/`);
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// The directory being typed into, and the start of the name inside it.
	const { parent, partial } = useMemo(() => {
		const slash = input.lastIndexOf("/");
		const dirPart = slash >= 0 ? input.slice(0, slash + 1) : "";
		return {
			parent: expandPath(dirPart || ".", home, currentPath),
			partial: slash >= 0 ? input.slice(slash + 1) : input,
		};
	}, [input, home, currentPath]);

	useEffect(() => {
		let cancelled = false;
		const timer = window.setTimeout(async () => {
			try {
				const res = await authFetch(
					`${filesApiBase}/list?${new URLSearchParams({ path: parent })}`,
				);
				if (!res.ok) {
					if (!cancelled) setSuggestions([]);
					return;
				}
				const data = (await res.json()) as { files: FileInfo[] };
				if (cancelled) return;
				const lower = partial.toLowerCase();
				setSuggestions(
					data.files
						.filter(
							(f) =>
								f.type === "directory" &&
								f.name.toLowerCase().startsWith(lower) &&
								(lower.startsWith(".") || !f.isHidden),
						)
						.slice(0, SUGGEST_MAX)
						.map((f) => f.path),
				);
			} catch {
				if (!cancelled) setSuggestions([]);
			}
		}, 150);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [parent, partial, filesApiBase]);

	const complete = (path: string) => {
		setInput(`${toHomeShortPath(path)}/`);
		setError(null);
		inputRef.current?.focus();
	};

	const open = async (path: string) => {
		setError(null);
		try {
			const res = await authFetch(
				`${filesApiBase}/list?${new URLSearchParams({ path })}`,
			);
			if (!res.ok) {
				setError(t("files.jumpCannotOpen"));
				return;
			}
		} catch {
			setError(t("files.jumpCannotOpen"));
			return;
		}
		onNavigate(path);
	};

	const row =
		"flex min-h-12 w-full items-center gap-3 px-5 text-left text-th-text active:bg-th-surface-hover";
	const section = "px-5 pb-1.5 pt-3.5 text-[11px] font-semibold tracking-wide text-th-text-muted";

	return (
		<div
			className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center"
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
			role="presentation"
		>
			<div
				className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-th-border bg-th-surface sm:max-w-md sm:rounded-2xl sm:border"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
				role="dialog"
				aria-label={t("files.jumpTitle")}
			>
				<div className="mx-auto mb-1 mt-2 h-1 w-10 rounded bg-zinc-700 sm:hidden" />
				<div className="flex items-center py-1.5 pl-5 pr-3">
					<h2 className="m-0 text-base font-semibold">{t("files.jumpTitle")}</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label={t("common.close")}
						className="ml-auto flex h-11 w-11 items-center justify-center text-th-text-secondary"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				<div className="overflow-y-auto pb-4">
					<form
						className="px-4"
						onSubmit={(e) => {
							e.preventDefault();
							void open(expandPath(input, home, currentPath));
						}}
					>
						<label
							htmlFor="file-jump-path"
							className="mb-1.5 ml-1 block text-xs text-th-text-secondary"
						>
							{t("files.jumpInputLabel")}
						</label>
						<div className="flex h-12 items-center gap-2 rounded-xl border-[1.5px] border-blue-500 bg-th-bg px-3">
							<input
								id="file-jump-path"
								ref={inputRef}
								value={input}
								onChange={(e) => {
									setInput(e.target.value);
									setError(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Tab" && suggestions[0]) {
										e.preventDefault();
										complete(suggestions[0]);
									}
								}}
								autoCapitalize="off"
								autoCorrect="off"
								autoComplete="off"
								spellCheck={false}
								className="min-w-0 flex-1 bg-transparent font-mono text-[15px] text-th-text outline-none"
							/>
							<button
								type="submit"
								className="h-8 shrink-0 rounded-lg bg-blue-600 px-3 text-[13px] text-white"
							>
								{t("files.jumpOpen")}
							</button>
						</div>
						{error && <div className="ml-1 mt-1.5 text-xs text-red-400">{error}</div>}
						{suggestions.length > 0 && (
							<div className="mt-1.5 overflow-hidden rounded-xl border border-th-border bg-[#0f0f0f]">
								{suggestions.map((path) => (
									<button
										key={path}
										type="button"
										onClick={() => complete(path)}
										className="flex min-h-11 w-full items-center gap-3 px-4 text-left active:bg-th-surface-hover"
									>
										<Folder className="h-[18px] w-[18px] shrink-0 text-yellow-400" />
										<span className="truncate font-mono text-sm text-th-text">
											{path.slice(path.lastIndexOf("/") + 1)}/
										</span>
									</button>
								))}
							</div>
						)}
					</form>

					<div className={section}>{t("files.jumpThisSession")}</div>
					<button type="button" className={row} onClick={() => onNavigate(workingDir)}>
						<Home className="h-[18px] w-[18px] shrink-0 text-blue-400" />
						<span className="flex min-w-0 flex-col">
							<span className="text-sm">{t("files.jumpWorkingDir")}</span>
							<span className="truncate font-mono text-xs text-th-text-muted">
								{toHomeShortPath(workingDir)}
							</span>
						</span>
					</button>

					{otherSessions.length > 0 && (
						<>
							<div className={section}>{t("files.jumpOtherSessions")}</div>
							{otherSessions.map((s) => (
								<button
									key={`${s.name}:${s.path}`}
									type="button"
									className={row}
									onClick={() => onNavigate(s.path)}
								>
									<Folder className="h-[18px] w-[18px] shrink-0 text-th-text-muted" />
									<span className="flex min-w-0 flex-col">
										<span className="truncate text-sm">{s.name}</span>
										<span className="truncate font-mono text-xs text-th-text-muted">
											{toHomeShortPath(s.path)}
										</span>
									</span>
								</button>
							))}
						</>
					)}

					{bookmarks.length > 0 && (
						<>
							<div className={section}>{t("files.jumpBookmarks")}</div>
							{bookmarks.map((path) => (
								<button key={path} type="button" className={row} onClick={() => onNavigate(path)}>
									<Star className="h-[18px] w-[18px] shrink-0 text-amber-500" />
									<span className="truncate font-mono text-sm">{toHomeShortPath(path)}</span>
								</button>
							))}
						</>
					)}

					{recent.length > 0 && (
						<>
							<div className={section}>{t("files.jumpRecent")}</div>
							{recent.map((path) => (
								<button key={path} type="button" className={row} onClick={() => onNavigate(path)}>
									<Clock className="h-[18px] w-[18px] shrink-0 text-th-text-muted" />
									<span className="truncate font-mono text-sm">{toHomeShortPath(path)}</span>
								</button>
							))}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
