import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { authFetch } from "../../services/api";
import { paneUrl } from "./pane-url";

export interface PaletteEntry {
	name: string;
	description?: string;
	kind: "builtin" | "command" | "skill";
}

/**
 * Claude Code's built-in commands that do their work without a terminal, as
 * the Claude app offers them. `/plugin`, `/resume` and the like open screens
 * of their own, which a chat cannot show. `/exit` is left out too: here it
 * leaves the pane at a shell prompt the chat cannot type into.
 */
const BUILTINS = [
	"compact",
	"clear",
	"context",
	"usage",
	"model",
	"effort",
	"fast",
	"rename",
	"recap",
	"config",
] as const;

/** The person's own commands, read once per pane: they change rarely, and a stale list costs a retype. */
export function usePaneCommands(
	sessionId: string,
	paneId: string,
	peerId: string | undefined,
	wanted: boolean,
): PaletteEntry[] {
	const { t } = useTranslation();
	const [custom, setCustom] = useState<PaletteEntry[]>([]);
	const loadedFor = useRef<string | null>(null);

	useEffect(() => {
		const key = `${peerId ?? ""}:${sessionId}:${paneId}`;
		if (!wanted || loadedFor.current === key) return;
		loadedFor.current = key;
		void authFetch(paneUrl(sessionId, paneId, peerId, "commands"))
			.then((res) => (res.ok ? res.json() : { commands: [] }))
			.then((data: { commands?: PaletteEntry[] }) => setCustom(data.commands ?? []))
			.catch(() => setCustom([]));
	}, [sessionId, paneId, peerId, wanted]);

	const builtins: PaletteEntry[] = BUILTINS.map((name) => ({
		name,
		description: t(`conversation.slash.${name}`),
		kind: "builtin",
	}));
	const builtinNames = new Set<string>(BUILTINS);
	return [...builtins, ...custom.filter((c) => !builtinNames.has(c.name))];
}

/** The word being typed when the composer holds only `/word` so far, else null. */
export function slashQuery(text: string): string | null {
	const m = /^\/([^\s/]*)$/.exec(text);
	return m ? (m[1] ?? "").toLowerCase() : null;
}

export function filterEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
	const starts = entries.filter((e) => e.name.toLowerCase().startsWith(query));
	const contains = entries.filter(
		(e) => !e.name.toLowerCase().startsWith(query) && e.name.toLowerCase().includes(query),
	);
	return [...starts, ...contains];
}

interface SlashPaletteProps {
	entries: PaletteEntry[];
	active: number;
	onPick: (entry: PaletteEntry) => void;
	onHover: (index: number) => void;
}

export function SlashPalette({ entries, active, onPick, onHover }: SlashPaletteProps) {
	const { t } = useTranslation();
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		listRef.current
			?.querySelector<HTMLElement>(`[data-index="${active}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [active]);

	if (entries.length === 0) return null;
	return (
		<div
			ref={listRef}
			role="listbox"
			aria-label={t("conversation.slashTitle")}
			className="mx-auto mb-2 max-h-[45vh] max-w-3xl overflow-y-auto rounded-2xl border border-cv-border bg-cv-surface shadow-black/30 shadow-lg"
			data-testid="chat-slash-palette"
		>
			{entries.map((entry, i) => (
				<button
					key={`${entry.kind}:${entry.name}`}
					type="button"
					role="option"
					aria-selected={i === active}
					data-index={i}
					// Keep the textarea focused so the soft keyboard stays up.
					onPointerDown={(e) => e.preventDefault()}
					onClick={() => onPick(entry)}
					onPointerEnter={() => onHover(i)}
					className={`flex w-full flex-col items-start gap-0.5 border-cv-border border-b px-3.5 py-2.5 text-left last:border-b-0 ${
						i === active ? "bg-cv-surface-hover" : ""
					}`}
				>
					<span className="flex items-center gap-2">
						<span className="text-[#e8957a] text-[15px]">/{entry.name}</span>
						{entry.kind !== "builtin" && (
							<span className="rounded border border-cv-border px-1.5 text-[10px] text-cv-text-secondary">
								{t(entry.kind === "skill" ? "conversation.slashSkill" : "conversation.slashCommand")}
							</span>
						)}
					</span>
					{entry.description && (
						<span className="line-clamp-2 text-cv-text-muted text-xs">
							{entry.description}
						</span>
					)}
				</button>
			))}
		</div>
	);
}
