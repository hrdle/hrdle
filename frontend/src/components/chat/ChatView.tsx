import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentProvider, IndicatorState } from "../../../../shared/types";
import { useAgentConversation } from "../../hooks/useAgentConversation";
import { useStewardEnabled, useStewardView } from "../../hooks/useSteward";
import { ConversationViewer } from "../ConversationViewer";
import { StewardSessionView } from "./StewardSessionView";

interface ChatViewProps {
	sessionId: string;
	title?: string;
	subtitle?: string;
	inline?: boolean;
	enabled?: boolean;
	/** Provider for the active session. Codex sessions skip the WebSocket stream
	 *  (server-side rollout-tail isn't implemented) and poll the HTTP endpoint. */
	agent?: AgentProvider;
	/** Thread id for thread-based agents, used as the conversation key. */
	agentSessionId?: string | null;
	/** Steward mode on a phone: the composer belongs to the fixed bottom bar,
	 *  which the soft keyboard cannot push off the screen. */
	composerInBar?: boolean;
	/** What the agent in this session is doing, for the steward's chat. */
	agentState?: IndicatorState;
	/** How many agent panes this workspace holds. Above one, each pane keeps
	 *  its own steward history. */
	agentPaneCount?: number;
	/** The pane that is picked, which above one agent is whose history is read. */
	paneId?: string;
	activity?: { tool: string; target?: string };
}

/**
 * Read-only view of a session's conversation.
 *
 * There is no composer: input goes to the pane through the terminal, and a
 * second place to type only made it ambiguous which one was listening.
 */
export function ChatView({
	sessionId,
	title,
	subtitle,
	inline = true,
	enabled = true,
	agent,
	agentSessionId,
	composerInBar,
	agentState,
	activity,
	agentPaneCount,
	paneId,
}: ChatViewProps) {
	const { t } = useTranslation();
	const stewardAvailable = useStewardEnabled();
	const [stewardView] = useStewardView();

	// The switch says whether this device shows the steward at all, so with it
	// off there is nothing here to choose between.
	const stewardOnScreen = stewardAvailable && stewardView;

	/**
	 * Which of the two this screen is showing.
	 *
	 * The steward's version used to *replace* the transcript, and the only way
	 * back was a global switch in the dashboard - so on a phone, where the
	 * terminal is a screen of its own, the raw conversation was unreachable from
	 * here. The route that was supposed to cover it does not: of 196 stored
	 * turns, 3 carried a link to their source, and of 450 thread entries, none
	 * did.
	 *
	 * The narrow screen is the glasses, and the summary is for them. This one is
	 * wide enough to choose, so with the steward on screen it chooses.
	 */
	const [view, setView] = useState<"steward" | "raw">(stewardView ? "steward" : "raw");
	useEffect(() => {
		setView(stewardView ? "steward" : "raw");
	}, [stewardView]);

	const showSteward = stewardOnScreen && view === "steward";

	const { messages, isReady, conversationId, error } = useAgentConversation({
		agent,
		sessionId,
		agentSessionId,
		// The transcript is not fetched while the summary is up; switching is
		// what asks for it.
		enabled: enabled && !showSteward,
	});

	const chooser = stewardOnScreen ? <ViewChooser value={view} onChange={setView} /> : null;

	if (showSteward) {
		return (
			<div className="flex h-full min-h-0 flex-col bg-cv-bg">
				{chooser}
				<div className="min-h-0 flex-1">
					<StewardSessionView
						sessionId={sessionId}
						agentSessionId={agentSessionId}
						composerInBar={composerInBar}
						agentState={agentState}
						activity={activity}
						agentPaneCount={agentPaneCount}
						paneId={paneId}
					/>
				</div>
			</div>
		);
	}

	const resolvedTitle = title ?? t("conversation.claude");
	const resolvedSubtitle =
		subtitle ??
		(conversationId
			? `${agent ?? "agent"}:${conversationId.slice(0, 8)}`
			: undefined);

	if (error) {
		const errorClass = inline ? "h-full" : "fixed inset-0 z-50";
		const errorMessage =
			error === "unsupported-agent"
				? t("conversation.errorUnsupportedAgent", { agent: String(agent) })
				: t("conversation.errorMissingAgent");
		return (
			<div
				className={`${errorClass} flex flex-col items-center justify-center bg-cv-bg px-6 text-center`}
			>
				<div className="mb-2 text-sm font-medium text-red-400">
					{t("conversation.errorTitle")}
				</div>
				<div className="max-w-sm text-xs leading-relaxed text-cv-text-muted">
					{errorMessage}
				</div>
			</div>
		);
	}

	// Avoid showing a "Loading..." flash every time the view opens. Until the
	// initial conversation arrives, render an empty container.
	if (!isReady && messages.length === 0) {
		const emptyClass = inline ? "h-full" : "fixed inset-0 z-50";
		return (
			<div className={`${emptyClass} flex min-h-0 flex-col bg-cv-bg`}>
				{chooser}
			</div>
		);
	}

	if (chooser) {
		return (
			<div className="flex h-full min-h-0 flex-col bg-cv-bg">
				{chooser}
				<div className="min-h-0 flex-1">
					<ConversationViewer
						title={resolvedTitle}
						subtitle={resolvedSubtitle}
						messages={messages}
						isLoading={false}
						onClose={() => {
							/* close handled by parent */
						}}
						scrollToBottom
						inline
						agent={agent}
					/>
				</div>
			</div>
		);
	}

	return (
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
			agent={agent}
		/>
	);
}

/**
 * Summary or conversation, on the screen showing them.
 *
 * Two words and a rule under the live one - not a pill, not a card. This sits
 * above a reading surface all day, and the quietest thing that can still be
 * found is the right amount of control here.
 */
function ViewChooser({
	value,
	onChange,
}: {
	value: "steward" | "raw";
	onChange: (next: "steward" | "raw") => void;
}) {
	const { t } = useTranslation();
	const options: { key: "steward" | "raw"; label: string }[] = [
		{ key: "steward", label: t("chat.summary", "要約") },
		{ key: "raw", label: t("chat.transcript", "会話") },
	];

	return (
		<div className="flex shrink-0 items-center gap-4 border-cv-border border-b px-3">
			{options.map((option) => {
				const live = option.key === value;
				return (
					<button
						key={option.key}
						type="button"
						onClick={() => onChange(option.key)}
						aria-pressed={live}
						className={`-mb-px min-h-9 border-b-2 px-0.5 text-[length:var(--cv-fs-meta,12px)] transition-colors ${
							live
								? "border-cv-accent font-medium text-cv-text"
								: "border-transparent text-cv-text-muted hover:text-cv-text"
						}`}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
