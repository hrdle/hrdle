import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	AGENT_PROVIDERS,
	type ExtendedSessionResponse,
	isAgentProvider,
	LOCAL_PEER_ID,
} from "../../../shared/types";
import {
	BOARD_GROUPS,
	type BoardGroup,
	boardPaneOf,
	groupSessionsForBoard,
} from "../utils/board-groups";
import { formatRelativeTime } from "../utils/format";

const GROUP_STYLE: Record<
	BoardGroup,
	{ text: string; dot: string; labelKey: string }
> = {
	needsYou: {
		text: "text-red-400",
		dot: "bg-red-400 animate-pulse",
		labelKey: "board.needsYou",
	},
	unseen: {
		text: "text-emerald-400",
		dot: "bg-emerald-400",
		labelKey: "board.unseen",
	},
	working: {
		text: "text-blue-400",
		dot: "bg-blue-400",
		labelKey: "board.working",
	},
	idle: { text: "text-zinc-500", dot: "bg-zinc-600", labelKey: "board.idle" },
};

interface WorkspaceBoardProps {
	sessions: ExtendedSessionResponse[];
	onSelectSession: (session: ExtendedSessionResponse) => void;
	onSelectPane?: (session: ExtendedSessionResponse, paneId: string) => void;
}

/**
 * The workspace list regrouped by what each agent needs from a person, one
 * line per workspace. It is a way to find a session, not to manage one:
 * renaming, reordering and pane operations stay on the list.
 */
export function WorkspaceBoard({
	sessions,
	onSelectSession,
	onSelectPane,
}: WorkspaceBoardProps) {
	const { t, i18n } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	// A session remembered from before a restart has no agent to report on;
	// it would only inflate "idle". The list is where it is resumed from.
	const sections = groupSessionsForBoard(
		sessions.filter((s) => s.state !== "lost"),
	);

	const open = (session: ExtendedSessionResponse) => {
		const pane = boardPaneOf(session);
		if (pane && onSelectPane) onSelectPane(session, pane.paneId);
		else onSelectSession(session);
	};

	const moveFocus = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const rows = Array.from(
			containerRef.current?.querySelectorAll<HTMLButtonElement>(
				"[data-board-row]",
			) ?? [],
		);
		if (rows.length === 0) return;
		e.preventDefault();
		const at = rows.indexOf(document.activeElement as HTMLButtonElement);
		const step = e.key === "ArrowDown" ? 1 : -1;
		const next = at < 0 ? 0 : (at + step + rows.length) % rows.length;
		rows[next]?.focus();
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the row buttons inside
		<div ref={containerRef} onKeyDown={moveFocus}>
			<div className="flex flex-wrap gap-1.5 mb-4">
				{BOARD_GROUPS.map((group) => (
					<div
						key={group}
						className="flex items-baseline gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.04]"
					>
						<span
							className={`text-[15px] font-semibold tabular-nums ${
								sections[group].length > 0
									? GROUP_STYLE[group].text
									: "text-zinc-600"
							}`}
						>
							{sections[group].length}
						</span>
						<span className="text-[12px] text-zinc-500">
							{t(GROUP_STYLE[group].labelKey)}
						</span>
					</div>
				))}
			</div>

			{BOARD_GROUPS.map((group) => {
				const rows = sections[group];
				if (rows.length === 0) return null;
				const style = GROUP_STYLE[group];
				return (
					<section key={group} className="mb-5">
						<div className="flex items-center gap-2 mb-1">
							<h3
								className={`text-[11px] font-medium uppercase tracking-wider ${style.text}`}
							>
								{t(style.labelKey)} {rows.length}
							</h3>
							<div className="flex-1 h-px bg-white/[0.06]" />
						</div>
						{rows.map((session) => {
							const pane = boardPaneOf(session);
							const title =
								pane?.recap ||
								session.ccRecap ||
								session.ccSummary ||
								session.ccFirstPrompt ||
								"";
							const since =
								pane?.statusSince || pane?.recapAt || session.ccRecapAt;
							const background = pane?.background;
							const agent = pane?.agent ?? session.agent;
							const agentLabel =
								agent && isAgentProvider(agent)
									? t(AGENT_PROVIDERS[agent].labelKey)
									: undefined;
							const remote =
								session.peerId && session.peerId !== LOCAL_PEER_ID
									? session.peerNickname
									: undefined;
							const where = [agentLabel, remote].filter(Boolean).join(" · ");
							return (
								<button
									key={`${session.peerId ?? "local"}:${session.id}`}
									type="button"
									data-board-row
									onClick={() => open(session)}
									className="w-full text-left grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,14rem)_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-0.5 px-2 py-2 rounded-md hover:bg-white/[0.04] active:bg-white/[0.06] focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400/60"
								>
									<span
										className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`}
									/>
									<span
										className={`text-[14px] font-medium text-zinc-100 truncate ${
											title || background ? "" : "sm:col-span-2"
										}`}
									>
										{session.name}
									</span>
									{(title || background) && (
										<span className="flex items-center gap-2 min-w-0 max-sm:col-start-2 max-sm:row-start-2 max-sm:col-span-2">
											{title && (
												<span className="text-[13px] text-zinc-400 truncate">
													{title}
												</span>
											)}
											{background && (
												<span className="shrink-0 px-1.5 py-px rounded border border-blue-400/40 text-[11px] text-blue-300 whitespace-nowrap">
													{t("board.background", {
														what: background.join(", "),
													})}
												</span>
											)}
										</span>
									)}
									<span className="text-[12px] text-zinc-600 truncate max-sm:hidden">
										{where}
									</span>
									<span className="text-[12px] text-zinc-600 tabular-nums whitespace-nowrap max-sm:col-start-3 max-sm:row-start-1">
										{since ? formatRelativeTime(since, t, i18n.language) : ""}
									</span>
								</button>
							);
						})}
					</section>
				);
			})}
		</div>
	);
}
