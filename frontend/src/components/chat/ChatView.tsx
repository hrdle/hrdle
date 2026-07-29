import { useTranslation } from "react-i18next";
import type { AgentProvider, SessionTheme } from "../../../../shared/types";
import { useAgentConversation } from "../../hooks/useAgentConversation";
import { useInputEcho } from "../../hooks/useInputEcho";
import { ConversationViewer } from "../ConversationViewer";
import { getTerminalThemes } from "../terminal-themes";
import { ChatComposer } from "./ChatComposer";

interface ChatViewProps {
	sessionId: string;
	title?: string;
	subtitle?: string;
	inline?: boolean;
	enabled?: boolean;
	/** Extra bottom padding (px) so trailing messages aren't covered by floating UI like a soft keyboard. */
	bottomPadding?: number;
	/** When set with a tmux paneId, render an input form below the conversation
	 *  (used on desktop where there's no soft keyboard / Terminal InputBar). */
	showComposer?: boolean;
	paneId?: string;
	/** Notified when the user starts a scroll gesture — parent can collapse
	 *  the keyboard / input bar to expand the visible area. */
	onScrollGesture?: () => void;
	/** Notified when the conversation transitions to/from the bottom. */
	onAtBottomChange?: (atBottom: boolean) => void;
	/** Session theme — propagated to ConversationViewer for matching bg color. */
	theme?: SessionTheme;
	/** Provider for the active session. Codex sessions skip the WebSocket stream
	 *  (server-side rollout-tail isn't implemented) and poll the HTTP endpoint. */
	agent?: AgentProvider;
	/** Codex thread id, used as the conversation key when agent=codex. */
	agentSessionId?: string | null;
	/** Remote-control mode: send composer input over REST instead of the mux WS
	 *  (which rejects input for sessions this client is not subscribed to). */
	sendInputOverRest?: (paneId: string, data: string) => Promise<boolean>;
}

export function ChatView({
	sessionId,
	title,
	subtitle,
	inline = true,
	enabled = true,
	bottomPadding,
	showComposer = false,
	paneId,
	onScrollGesture,
	onAtBottomChange,
	theme,
	agent,
	agentSessionId,
	sendInputOverRest,
}: ChatViewProps) {
	const { t } = useTranslation();
	const { messages, isReady, conversationId, error } = useAgentConversation({
		agent,
		sessionId,
		agentSessionId,
		enabled,
	});
	const echo = useInputEcho(sessionId);

	const resolvedTitle = title ?? t("conversation.claude");
	const resolvedSubtitle =
		subtitle ??
		(conversationId
			? `${agent ?? "agent"}:${conversationId.slice(0, 8)}`
			: undefined);

	const themeBg = getTerminalThemes()[theme || "default"].background;

	if (error) {
		const errorClass = inline ? "h-full" : "fixed inset-0 z-50";
		const errorMessage =
			error === "unsupported-agent"
				? t("conversation.errorUnsupportedAgent", { agent: String(agent) })
				: t("conversation.errorMissingAgent");
		return (
			<div
				className={`${errorClass} flex flex-col items-center justify-center px-6 text-center`}
				style={{ backgroundColor: themeBg }}
			>
				<div className="text-sm font-medium text-red-300 mb-2">
					{t("conversation.errorTitle")}
				</div>
				<div className="text-xs text-th-text-muted max-w-sm leading-relaxed">
					{errorMessage}
				</div>
			</div>
		);
	}

	// Avoid showing a "Loading..." flash every time the view opens. Until the
	// initial conversation arrives, render an empty container.
	if (!isReady && messages.length === 0) {
		const emptyClass = inline ? "h-full" : "fixed inset-0 z-50";
		return <div className={emptyClass} style={{ backgroundColor: themeBg }} />;
	}

	const composer = showComposer ? (
		<ChatComposer
			sessionId={sessionId}
			paneId={paneId}
			sendOverRest={sendInputOverRest}
		/>
	) : null;

	// Prompt-style line at the bottom of the conversation showing what the user
	// is currently typing via FloatingKeyboard / InputBar (terminal echo
	// surrogate). Only relevant when the in-view composer is not present.
	const echoLine = !composer ? (
		<div
			className="shrink-0 px-3 py-1.5 border-t border-white/[0.06] font-mono text-[13px] text-zinc-300 whitespace-pre overflow-x-auto min-h-[32px] flex items-center"
			style={{ backgroundColor: themeBg }}
		>
			<span className="text-blue-400/70 mr-2 select-none">{">"}</span>
			{echo ? (
				<span>
					{echo}
					<span className="inline-block w-[8px] h-[14px] bg-zinc-300 ml-[1px] align-middle animate-pulse" />
				</span>
			) : (
				<span className="text-zinc-700">Waiting for input...</span>
			)}
		</div>
	) : null;

	const viewer = (
		<ConversationViewer
			title={resolvedTitle}
			subtitle={resolvedSubtitle}
			messages={messages}
			isLoading={false}
			onClose={() => {
				/* close handled by parent */
			}}
			scrollToBottom
			inline={inline}
			onScrollGesture={onScrollGesture}
			onAtBottomChange={onAtBottomChange}
			theme={theme}
			agent={agent}
		/>
	);

	if (composer || echoLine) {
		return (
			<div
				className="h-full flex flex-col"
				style={bottomPadding ? { paddingBottom: bottomPadding } : undefined}
			>
				<div className="flex-1 min-h-0">{viewer}</div>
				{echoLine}
				{composer}
			</div>
		);
	}

	if (bottomPadding && bottomPadding > 0) {
		return (
			<div
				className="h-full flex flex-col"
				style={{ paddingBottom: bottomPadding }}
			>
				{viewer}
			</div>
		);
	}

	return viewer;
}
