/** biome-ignore-all lint/correctness/useExhaustiveDependencies: depends on refs and setters that React guarantees stable; adding them would cause unintended re-runs */
/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import {
	ExternalLink,
	MessageSquare,
	Terminal as TerminalIcon,
	Unplug,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type AgentProvider,
	type PaneInfo,
	samePeerId,
	type SessionState,
	type SessionTheme,
} from "../../../shared/types";
import { openClaudeAppSession } from "../utils/claude-app";
import { makeSessionKey, parseSessionKey } from "../utils/sessionKey";
import { toHomeShortPath } from "../utils/path";
import { ChatView } from "./chat/ChatView";
import type { ControlModeConfig } from "./Terminal";
import { TerminalComponent, type TerminalRef } from "./Terminal";
import { soleVisiblePane, visiblePanes } from "../utils/panes";

// Pane node types.
// sessionKey is the composite `peerId:id` key (utils/sessionKey.ts): session ids
// (herdr workspace names) collide across peers, so the tree always holds the
// composite key.
export type PaneNode =
	| { type: "terminal"; sessionKey: string | null; id: string }
	| {
			type: "split";
			direction: "horizontal" | "vertical";
			children: PaneNode[];
			ratio: number[];
			id: string;
	  };

// Extended session type with ccSessionId
interface ExtendedSession {
	id: string;
	name: string;
	instanceId?: string;
	state: SessionState;
	currentPath?: string;
	ccSessionId?: string;
	// Remote Control deep-link target (`session_…`). Present only while Remote
	// Control is active; drives the "Open in Claude app" header button.
	bridgeSessionId?: string;
	agent?: AgentProvider;
	agentSessionId?: string;
	currentCommand?: string;
	theme?: SessionTheme;
	panes?: PaneInfo[];
	// Multi-server: peer this session lives on. Unset = local Hub.
	peerId?: string;
}

// Control mode context passed through the pane tree
export interface ControlModeContext {
	getControlConfig: (paneId: string) => ControlModeConfig | undefined;
	splitPane: (paneId: string, direction: "h" | "v") => void;
	closePane: (paneId: string) => void;
	zoomPane?: (paneId: string) => void;
	isZoomed?: boolean;
	onCopyPrompt?: (text: string) => void;
	setKeyboardVisible?: (visible: boolean) => void;
	onShowSessions?: () => void;
	onOpenFileViewer?: (dir: string, peerId?: string) => void;
	/** Remote-control mode (PC only): the xterm area shows a placeholder and
	 * the local herdr client owns the terminal. */
	remoteControl?: boolean;
}

interface PaneContainerProps {
	node: PaneNode;
	activePane: string;
	onFocusPane: (paneId: string) => void;
	onSelectSession: (paneId: string, sessionKey?: string) => void;
	onSessionStateChange: (sessionKey: string, state: SessionState) => void;
	// dividerIndex = which divider moved (between children[i] and children[i+1]);
	// parents use it for boundary-style renormalization of nested splits.
	onSplitRatioChange: (
		nodeId: string,
		ratio: number[],
		dividerIndex: number,
	) => void;
	// Fires when a divider drag physically starts (pointer/touch down) and
	// ends (release). Lets the parent defer server layout application mid-drag.
	onSplitDragStateChange?: (active: boolean) => void;
	onClosePane: (paneId: string) => void;
	onSplit?: (direction: "horizontal" | "vertical") => void;
	sessions: ExtendedSession[];
	terminalRefs: React.RefObject<Map<string, TerminalRef | null>>;
	isTablet?: boolean;
	globalReloadKey?: number;
	controlModeContext: ControlModeContext;
}

export function PaneContainer({
	node,
	activePane,
	onFocusPane,
	onSelectSession,
	onSessionStateChange,
	onSplitRatioChange,
	onSplitDragStateChange,
	onClosePane,
	onSplit,
	sessions,
	terminalRefs,
	isTablet = false,
	globalReloadKey = 0,
	controlModeContext,
}: PaneContainerProps) {
	if (node.type === "terminal") {
		return (
			<TerminalPane
				paneId={node.id}
				sessionKey={node.sessionKey}
				isActive={activePane === node.id}
				onFocus={() => onFocusPane(node.id)}
				onSelectSession={(sessionKey) => onSelectSession(node.id, sessionKey)}
				onSessionStateChange={onSessionStateChange}
				onClose={() => onClosePane(node.id)}
				onSplit={onSplit}
				sessions={sessions}
				terminalRefs={terminalRefs}
				globalReloadKey={globalReloadKey}
				isTablet={isTablet}
				controlModeContext={controlModeContext}
			/>
		);
	}

	if (node.type === "split") {
		return (
			<SplitContainer
				node={node}
				activePane={activePane}
				onFocusPane={onFocusPane}
				onSelectSession={onSelectSession}
				onSessionStateChange={onSessionStateChange}
				onSplitRatioChange={onSplitRatioChange}
				onSplitDragStateChange={onSplitDragStateChange}
				onClosePane={onClosePane}
				onSplit={onSplit}
				sessions={sessions}
				terminalRefs={terminalRefs}
				isTablet={isTablet}
				globalReloadKey={globalReloadKey}
				controlModeContext={controlModeContext}
			/>
		);
	}

	// Unknown pane type - should not happen
	return null;
}

interface TerminalPaneProps {
	paneId: string;
	sessionKey: string | null;
	isActive: boolean;
	onFocus: () => void;
	onSelectSession: (sessionKey?: string) => void;
	onSessionStateChange: (sessionKey: string, state: SessionState) => void;
	onClose: () => void;
	onSplit?: (direction: "horizontal" | "vertical") => void;
	sessions: ExtendedSession[];
	terminalRefs: React.RefObject<Map<string, TerminalRef | null>>;
	globalReloadKey?: number;
	isTablet?: boolean;
	controlModeContext: ControlModeContext;
}

function TerminalPane({
	paneId,
	sessionKey,
	isActive,
	onFocus,
	onSelectSession,
	onSessionStateChange,
	onClose,
	onSplit: _onSplit,
	sessions,
	terminalRefs,
	globalReloadKey = 0,
	isTablet = false,
	controlModeContext,
}: TerminalPaneProps) {
	const { t } = useTranslation();
	const terminalRef = useRef<TerminalRef>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	// The tree stores composite keys; the wire (WS subscribe, REST paths) only
	// ever sees the bare id.
	const sessionTarget = sessionKey ? parseSessionKey(sessionKey) : null;
	const session = sessionTarget
		? (sessions.find(
				(s) =>
					s.id === sessionTarget.id && samePeerId(s.peerId, sessionTarget.peerId),
			) ?? null)
		: null;
	// Persist chat-mode state per pane so it survives remounts (e.g. after a
	// split changes the React tree from <TerminalPane> to <SplitContainer>).
	const conversationModeKey = sessionKey
		? `cchub-pane-conv-mode:${sessionKey}:${paneId}`
		: null;
	const [showConversation, setShowConversationState] = useState<boolean>(() => {
		if (!conversationModeKey) return false;
		try {
			return localStorage.getItem(conversationModeKey) === "1";
		} catch {
			return false;
		}
	});
	const setShowConversation = useCallback<
		React.Dispatch<React.SetStateAction<boolean>>
	>(
		(next) => {
			setShowConversationState((prev) => {
				const value =
					typeof next === "function"
						? (next as (p: boolean) => boolean)(prev)
						: next;
				if (conversationModeKey) {
					try {
						if (value) localStorage.setItem(conversationModeKey, "1");
						else localStorage.removeItem(conversationModeKey);
					} catch {
						/* ignore */
					}
				}
				return value;
			});
		},
		[conversationModeKey],
	);
	const [reloadKey, setReloadKey] = useState(0);
	const [confirmClose, setConfirmClose] = useState(false);
	const confirmCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	// Refresh terminal display (force a viewport refresh without remounting)
	const handleReload = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		if (terminalRef.current?.refreshTerminal) {
			terminalRef.current.refreshTerminal();
		} else {
			// Fallback: remount terminal
			setReloadKey((prev) => prev + 1);
		}
	}, []);

	// Open file viewer (hide keyboard while open)
	const handleOpenFileViewer = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			controlModeContext.onOpenFileViewer?.(
				session?.currentPath || "/",
				session?.peerId,
			);
			controlModeContext.setKeyboardVisible?.(false);
		},
		[controlModeContext, session],
	);

	// Cleanup confirm close timer on unmount
	useEffect(() => {
		return () => {
			if (confirmCloseTimerRef.current) {
				clearTimeout(confirmCloseTimerRef.current);
			}
		};
	}, []);

	// Register terminal ref
	useEffect(() => {
		if (sessionKey && terminalRef.current) {
			terminalRefs.current.set(paneId, terminalRef.current);
		}
		return () => {
			terminalRefs.current.delete(paneId);
		};
	}, [paneId, sessionKey, terminalRefs]);

	const handleConnect = useCallback(() => {
		if (sessionKey) {
			onSessionStateChange(sessionKey, "idle");
		}
	}, [sessionKey, onSessionStateChange]);

	const handleDisconnect = useCallback(() => {
		if (sessionKey) {
			onSessionStateChange(sessionKey, "disconnected");
		}
	}, [sessionKey, onSessionStateChange]);

	// Re-read persisted state when the (sessionKey, paneId) pair changes — e.g.
	// user picks a different session in this pane. Initial mount already
	// hydrated from localStorage via useState, so this is a no-op then.
	useEffect(() => {
		if (!conversationModeKey) {
			setShowConversationState(false);
			return;
		}
		try {
			setShowConversationState(
				localStorage.getItem(conversationModeKey) === "1",
			);
		} catch {
			setShowConversationState(false);
		}
	}, [conversationModeKey]);

	// Fall back to terminal view only if pane data has loaded AND no supported
	// agent is running on the active pane. Without the loaded check, the very
	// first render after remount (e.g. after a split) sees panes=undefined and
	// would wrongly clear chat mode.
	const controlledPaneId = controlModeContext.getControlConfig(paneId)?.paneId;
	const activeTmuxPane =
		session?.panes?.find((p) => p.paneId === controlledPaneId) ??
		session?.panes?.find((p) => p.isActive) ??
		soleVisiblePane(session);
	const conversationAvailable = !!(
		activeTmuxPane?.agent && activeTmuxPane.agentSessionId
	);
	const panesLoaded = !!session?.panes;
	useEffect(() => {
		if (!panesLoaded) return;
		if (!conversationAvailable && showConversation) {
			setShowConversation(false);
		}
	}, [
		conversationAvailable,
		showConversation,
		panesLoaded,
		setShowConversation,
	]);

	const handleToggleConversation = useCallback(() => {
		setShowConversation((prev) => !prev);
	}, []);

	return (
		<div
			ref={containerRef}
			className={`h-full flex flex-col bg-th-bg relative select-none ${isActive ? "ring-2 ring-blue-500" : ""}`}
			onMouseDown={onFocus}
		>
			{/* Pane header - overlay on tablet, normal on desktop */}
			<div
				className={`flex items-center px-2 py-1 text-base select-none ${
					isTablet
						? "absolute top-0 right-0 z-50 justify-end pointer-events-auto bg-[var(--color-overlay)] backdrop-blur-sm rounded-bl-lg"
						: "justify-between bg-[var(--color-overlay)] border-b border-th-border shrink-0"
				}`}
			>
				{!isTablet && (
					<span className="text-th-text-secondary truncate flex-1">
						{showConversation
							? t("conversation.history")
							: session?.name || t("pane.noSession")}
					</span>
				)}
				<div className={`flex items-center ${isTablet ? "gap-0" : "gap-1.5"}`}>
					{/* Terminal / Chat single-icon toggle — shows the destination mode */}
					{(() => {
						const disabled = !showConversation && !conversationAvailable;
						return (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									if (!disabled) handleToggleConversation();
								}}
								disabled={disabled}
								className={`${isTablet ? "p-2" : "p-1"} rounded transition-colors ${
									disabled
										? "text-white/20 cursor-not-allowed"
										: "text-white/60 hover:text-th-text hover:bg-white/[0.06]"
								}`}
								title={
									showConversation
										? "Switch to terminal"
										: conversationAvailable
											? "Switch to conversation history"
											: "No agent is running"
								}
								aria-label={
									showConversation ? "Switch to Terminal" : "Switch to Chat"
								}
							>
								{showConversation ? (
									<TerminalIcon
										className={isTablet ? "w-4 h-4" : "w-[14px] h-[14px]"}
									/>
								) : (
									<MessageSquare
										className={isTablet ? "w-4 h-4" : "w-[14px] h-[14px]"}
									/>
								)}
							</button>
						);
					})()}
					{/* Open the matching Remote Control session in the Claude app */}
					{session?.bridgeSessionId && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								const bridgeId = session.bridgeSessionId;
								if (!bridgeId) return;
								openClaudeAppSession(bridgeId);
							}}
							className={`${isTablet ? "p-2" : "p-1"} rounded transition-colors text-violet-300/80 hover:text-violet-200 hover:bg-violet-500/10`}
							title={t("session.openInClaudeApp")}
							aria-label={t("session.openInClaudeApp")}
						>
							<ExternalLink
								className={isTablet ? "w-4 h-4" : "w-[14px] h-[14px]"}
							/>
						</button>
					)}

					{/* File browser button (desktop only) */}
					{!isTablet && session?.currentPath && !showConversation && (
						<button
							type="button"
							onClick={handleOpenFileViewer}
							className="p-1.5 text-white/50 hover:text-th-text transition-colors"
							title={t("files.title")}
							data-onboarding="file-browser"
						>
							<svg
								aria-hidden="true"
								className="w-[18px] h-[18px]"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
								/>
							</svg>
						</button>
					)}
					{/* Reload button (desktop only) */}
					{!isTablet && sessionKey && !showConversation && (
						<button
							type="button"
							onClick={handleReload}
							className="p-1.5 text-white/50 hover:text-th-text transition-colors"
							title={t("files.reload")}
						>
							<svg
								aria-hidden="true"
								className="w-[18px] h-[18px]"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
								/>
							</svg>
						</button>
					)}
					{/* Zoom button — only meaningful when there are multiple panes.
              Counted among the ones on screen: `panes` spans every tab, and
              zooming is about the layout in front of you. */}
					{sessionKey &&
						!showConversation &&
						controlModeContext.zoomPane &&
						visiblePanes(session).length > 1 && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									controlModeContext.zoomPane?.(paneId);
								}}
								className={`${isTablet ? "p-2.5" : "p-1.5"} transition-colors ${
									controlModeContext.isZoomed
										? "text-blue-400 hover:text-blue-300"
										: "text-white/50 hover:text-th-text"
								}`}
								title={controlModeContext.isZoomed ? "Unzoom" : "Zoom"}
							>
								{controlModeContext.isZoomed ? (
									<svg
										aria-hidden="true"
										className={isTablet ? "w-5 h-5" : "w-[18px] h-[18px]"}
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											strokeWidth={2}
											d="M9 4H4m0 0v5m0-5l5 5m6-5h5m0 0v5m0-5l-5 5M9 20H4m0 0v-5m0 5l5-5m6 5h5m0 0v-5m0 5l-5-5"
										/>
									</svg>
								) : (
									<svg
										aria-hidden="true"
										className={isTablet ? "w-5 h-5" : "w-[18px] h-[18px]"}
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											strokeWidth={2}
											d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
										/>
									</svg>
								)}
							</button>
						)}
					{/* Split buttons - desktop only */}
					{!isTablet && (
						<div className="flex items-center" data-onboarding="split-pane">
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									controlModeContext.splitPane(paneId, "h");
								}}
								className="p-1.5 text-white/50 hover:text-th-text transition-colors"
								title="Split vertically (Ctrl+D)"
								data-onboarding="split-pane"
							>
								<svg
									aria-hidden="true"
									className="w-[18px] h-[18px]"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth={2}
								>
									<rect x="3" y="3" width="18" height="18" rx="2" />
									<line x1="12" y1="3" x2="12" y2="21" />
								</svg>
							</button>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									controlModeContext.splitPane(paneId, "v");
								}}
								className="p-1.5 text-white/50 hover:text-th-text transition-colors"
								title="Split horizontally (Ctrl+Shift+D)"
							>
								<svg
									aria-hidden="true"
									className="w-[18px] h-[18px]"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth={2}
								>
									<rect x="3" y="3" width="18" height="18" rx="2" />
									<line x1="3" y1="12" x2="21" y2="12" />
								</svg>
							</button>
						</div>
					)}
					{/* Close button with confirmation — only shown when there are
              multiple panes on screen (the backend rejects closing the last
              one). Counting every tab's panes would offer to close the only
              pane the reader can see. */}
					{visiblePanes(session).length > 1 && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								if (confirmClose) {
									if (confirmCloseTimerRef.current) {
										clearTimeout(confirmCloseTimerRef.current);
										confirmCloseTimerRef.current = null;
									}
									setConfirmClose(false);
									onClose();
								} else {
									setConfirmClose(true);
									confirmCloseTimerRef.current = setTimeout(() => {
										setConfirmClose(false);
										confirmCloseTimerRef.current = null;
									}, 3000);
								}
							}}
							className={`${isTablet ? "p-2.5" : "p-1.5"} transition-colors ${
								confirmClose
									? "text-red-400 bg-red-900/50 rounded"
									: "text-white/50 hover:text-red-400"
							}`}
							title={confirmClose ? t("pane.confirmClose") : t("common.close")}
						>
							{confirmClose ? (
								<span
									className={`${isTablet ? "text-xs" : "text-[10px]"} font-bold whitespace-nowrap`}
								>
									{t("pane.confirmClose")}
								</span>
							) : (
								<svg
									aria-hidden="true"
									className={isTablet ? "w-5 h-5" : "w-[18px] h-[18px]"}
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
							)}
						</button>
					)}
				</div>
			</div>

			{/* Terminal, conversation, or session selector */}
			<div className="flex-1 min-h-0">
				{showConversation && sessionTarget && (
					<ChatView
						sessionId={sessionTarget.id}
						title={t("conversation.history")}
						subtitle={session?.name}
						inline={true}
						enabled={showConversation}
						agent={activeTmuxPane?.agent}
						agentSessionId={activeTmuxPane?.agentSessionId}
					/>
				)}
				{sessionTarget ? (
					<div className={showConversation ? "hidden" : "h-full"}>
						<TerminalComponent
							key={`${sessionKey}-${session?.instanceId ?? "legacy"}-${reloadKey}-${globalReloadKey}`}
							ref={terminalRef}
							sessionId={sessionTarget.id}
							peerId={sessionTarget.peerId}
							hideKeyboard={true}
							onConnect={handleConnect}
							onDisconnect={handleDisconnect}
							theme={session?.theme}
							controlMode={controlModeContext.getControlConfig(paneId)}
							hideTerminalArea={!!controlModeContext.remoteControl}
							terminalAreaOverlay={
								controlModeContext.remoteControl ? (
									<div className="h-full flex flex-col items-center justify-center gap-2 p-4 text-center select-none">
										<Unplug className="w-8 h-8 text-zinc-600" aria-hidden />
										<p className="text-th-text-secondary text-sm font-medium">
											{t("remoteControl.active")}
										</p>
										<p className="text-th-text-muted text-xs max-w-[280px]">
											{t("remoteControl.hint")}
										</p>
										{conversationAvailable && (
											<button
												type="button"
												onClick={() => setShowConversation(true)}
												className="mt-2 px-3 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-th-text-secondary hover:text-th-text rounded-md text-xs transition-colors"
											>
												{t("remoteControl.openChat")}
											</button>
										)}
									</div>
								) : undefined
							}
						/>
					</div>
				) : (
					!showConversation && (
						<SessionSelector
							sessions={sessions}
							onSelect={(sess) => {
								onSelectSession(makeSessionKey(sess.id, sess.peerId));
							}}
						/>
					)
				)}
			</div>
		</div>
	);
}

interface SessionSelectorProps {
	sessions: ExtendedSession[];
	onSelect: (session: ExtendedSession) => void;
}

function SessionSelector({ sessions, onSelect }: SessionSelectorProps) {
	const { t } = useTranslation();
	return (
		<div className="h-full flex flex-col items-center justify-center bg-th-bg p-4">
			<p className="text-th-text-secondary mb-4">{t("pane.selectSession")}</p>
			<div className="max-h-64 overflow-y-auto w-full max-w-xs space-y-2">
				{sessions.map((session) => (
					<button
						type="button"
						key={session.id}
						onClick={() => onSelect(session)}
						className="w-full text-left px-3 py-2 bg-th-surface hover:bg-th-surface-hover rounded text-th-text text-sm transition-colors"
					>
						<div className="font-medium truncate">{session.name}</div>
						{session.currentPath && (
							<div className="text-xs text-th-text-secondary truncate">
								{toHomeShortPath(session.currentPath)}
							</div>
						)}
					</button>
				))}
				{sessions.length === 0 && (
					<p className="text-th-text-muted text-sm text-center">
						{t("session.noSessions")}
					</p>
				)}
			</div>
		</div>
	);
}

interface SplitContainerProps {
	node: Extract<PaneNode, { type: "split" }>;
	activePane: string;
	onFocusPane: (paneId: string) => void;
	onSelectSession: (paneId: string, sessionKey?: string) => void;
	onSessionStateChange: (sessionKey: string, state: SessionState) => void;
	onSplitRatioChange: (
		nodeId: string,
		ratio: number[],
		dividerIndex: number,
	) => void;
	onSplitDragStateChange?: (active: boolean) => void;
	onClosePane: (paneId: string) => void;
	onSplit?: (direction: "horizontal" | "vertical") => void;
	sessions: ExtendedSession[];
	terminalRefs: React.RefObject<Map<string, TerminalRef | null>>;
	isTablet?: boolean;
	globalReloadKey?: number;
	controlModeContext: ControlModeContext;
}

function SplitContainer({
	node,
	activePane,
	onFocusPane,
	onSelectSession,
	onSessionStateChange,
	onSplitRatioChange,
	onSplitDragStateChange,
	onClosePane,
	onSplit,
	sessions,
	terminalRefs,
	isTablet = false,
	globalReloadKey = 0,
	controlModeContext,
}: SplitContainerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [isDragging, setIsDragging] = useState<number | null>(null);
	const draggingRef = useRef<number | null>(null);

	// Always-current node so the drag handlers read the latest ratios without
	// re-subscribing document listeners on every move.
	const nodeRef = useRef(node);
	nodeRef.current = node;

	// Coalesce ratio updates to one per animation frame. A tablet drag fires
	// pointer AND touch events for the same finger, so without this each physical
	// move rebuilt the whole pane tree twice and the divider lagged behind.
	const rafRef = useRef<number | null>(null);
	const pendingRatioRef = useRef<{ ratio: number[]; index: number } | null>(
		null,
	);
	const flushRatio = useCallback(() => {
		const pending = pendingRatioRef.current;
		pendingRatioRef.current = null;
		if (pending)
			onSplitRatioChange(nodeRef.current.id, pending.ratio, pending.index);
	}, [onSplitRatioChange]);
	const scheduleRatioChange = useCallback(
		(ratio: number[], index: number) => {
			pendingRatioRef.current = { ratio, index };
			if (rafRef.current !== null) return;
			rafRef.current = requestAnimationFrame(() => {
				rafRef.current = null;
				flushRatio();
			});
		},
		[flushRatio],
	);
	// Keep the latest drag-state callback in a ref so drag handlers stay stable.
	const dragStateChangeRef = useRef(onSplitDragStateChange);
	dragStateChangeRef.current = onSplitDragStateChange;

	const endDrag = useCallback(() => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
		flushRatio(); // land exactly under the finger, not on the last frame
		setIsDragging(null);
		draggingRef.current = null;
		dragStateChangeRef.current?.(false);
	}, [flushRatio]);

	// Shared ratio math for both the pointer and touch drag paths.
	const computeNewRatio = useCallback((clientPos: number): number[] | null => {
		const dragIndex = draggingRef.current;
		if (dragIndex === null || !containerRef.current) return null;
		const currentNode = nodeRef.current;
		const rect = containerRef.current.getBoundingClientRect();
		const containerSize =
			currentNode.direction === "horizontal" ? rect.width : rect.height;
		const offset =
			currentNode.direction === "horizontal" ? rect.left : rect.top;

		const newRatio = [...currentNode.ratio];
		const beforeSum = currentNode.ratio
			.slice(0, dragIndex + 1)
			.reduce((a, b) => a + b, 0);
		const afterSum = currentNode.ratio
			.slice(dragIndex + 1)
			.reduce((a, b) => a + b, 0);
		const position = ((clientPos - offset) / containerSize) * 100;
		const minRatio = 10;
		const newBefore = Math.max(
			minRatio,
			Math.min(beforeSum + afterSum - minRatio, position),
		);
		const diff = newBefore - beforeSum;

		if (
			newRatio[dragIndex] === undefined ||
			newRatio[dragIndex + 1] === undefined
		)
			return null;
		newRatio[dragIndex] = newRatio[dragIndex] + diff;
		newRatio[dragIndex + 1] = newRatio[dragIndex + 1] - diff;
		if (newRatio[dragIndex] < minRatio || newRatio[dragIndex + 1] < minRatio)
			return null;
		return newRatio;
	}, []);

	// Pointer-capture based drag: all pointer events go to the captured element
	const handlePointerDown = useCallback(
		(index: number) => (e: React.PointerEvent) => {
			e.preventDefault();
			e.currentTarget.setPointerCapture(e.pointerId);
			setIsDragging(index);
			draggingRef.current = index;
			dragStateChangeRef.current?.(true);
		},
		[],
	);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent) => {
			const dragIndex = draggingRef.current;
			if (dragIndex === null) return;
			e.preventDefault();
			const currentNode = nodeRef.current;
			const clientPos =
				currentNode.direction === "horizontal" ? e.clientX : e.clientY;
			const ratio = computeNewRatio(clientPos);
			if (ratio) scheduleRatioChange(ratio, dragIndex);
		},
		[computeNewRatio, scheduleRatioChange],
	);

	const handlePointerUp = useCallback(
		(e: React.PointerEvent) => {
			if (draggingRef.current === null) return;
			e.currentTarget.releasePointerCapture(e.pointerId);
			endDrag();
		},
		[endDrag],
	);

	// Touch fallback for devices that don't support pointer capture well
	const handleTouchStart = useCallback(
		(index: number) => () => {
			// No preventDefault: React registers `touchstart` passively, so it is
			// ignored and only produces a console violation. The `touchAction:
			// "none"` on this element is what keeps the drag from scrolling.
			setIsDragging(index);
			draggingRef.current = index;
			dragStateChangeRef.current?.(true);
		},
		[],
	);

	useEffect(() => {
		if (draggingRef.current === null) return;

		const handleTouchMove = (e: TouchEvent) => {
			e.preventDefault();
			const dragIndex = draggingRef.current;
			if (dragIndex === null) return;
			const touch = e.touches[0];
			if (!touch) return;
			const currentNode = nodeRef.current;
			const clientPos =
				currentNode.direction === "horizontal" ? touch.clientX : touch.clientY;
			const ratio = computeNewRatio(clientPos);
			if (ratio) scheduleRatioChange(ratio, dragIndex);
		};

		document.addEventListener("touchmove", handleTouchMove, { passive: false });
		document.addEventListener("touchend", endDrag);

		return () => {
			document.removeEventListener("touchmove", handleTouchMove);
			document.removeEventListener("touchend", endDrag);
		};
	}, [isDragging, computeNewRatio, scheduleRatioChange, endDrag]);

	// Cancel any pending frame if the divider unmounts mid-drag.
	useEffect(
		() => () => {
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
		},
		[],
	);

	const isHorizontal = node.direction === "horizontal";

	// Divider size: 4px on desktop, 8px on tablet
	const dividerSize = isTablet ? 8 : 4;

	// Build elements array with panes and dividers interleaved
	const elements: React.ReactNode[] = [];
	node.children.forEach((child, index) => {
		// Child pane
		elements.push(
			<div
				key={child.id}
				style={{
					[isHorizontal ? "width" : "height"]:
						`calc(${node.ratio[index]}% - ${index < node.children.length - 1 ? dividerSize / 2 : 0}px)`,
					[isHorizontal ? "height" : "width"]: "100%",
				}}
				className="flex-shrink-0 overflow-hidden"
			>
				<PaneContainer
					node={child}
					activePane={activePane}
					onFocusPane={onFocusPane}
					onSelectSession={onSelectSession}
					onSessionStateChange={onSessionStateChange}
					onSplitRatioChange={onSplitRatioChange}
					onSplitDragStateChange={onSplitDragStateChange}
					onClosePane={onClosePane}
					onSplit={onSplit}
					sessions={sessions}
					terminalRefs={terminalRefs}
					isTablet={isTablet}
					globalReloadKey={globalReloadKey}
					controlModeContext={controlModeContext}
				/>
			</div>,
		);

		// Divider (not after last child)
		if (index < node.children.length - 1) {
			elements.push(
				<div
					key={`divider-${child.id}`}
					style={{
						[isHorizontal ? "width" : "height"]: `${dividerSize}px`,
						position: "relative",
					}}
					className={`
            ${isHorizontal ? "h-full cursor-col-resize" : "w-full cursor-row-resize"}
            flex items-center justify-center bg-th-surface-hover hover:bg-blue-500/50 transition-colors flex-shrink-0 z-10
            ${isDragging === index ? "bg-blue-500/70" : ""}
          `}
				>
					{/* Expanded touch/click target for easier dragging */}
					<div
						onPointerDown={handlePointerDown(index)}
						onPointerMove={handlePointerMove}
						onPointerUp={handlePointerUp}
						onTouchStart={handleTouchStart(index)}
						style={{
							position: "absolute",
							[isHorizontal ? "left" : "top"]: isTablet ? "-16px" : "-8px",
							[isHorizontal ? "right" : "bottom"]: isTablet ? "-16px" : "-8px",
							[isHorizontal ? "top" : "left"]: "0",
							[isHorizontal ? "bottom" : "right"]: "0",
							touchAction: "none",
							zIndex: 20,
						}}
						className={isHorizontal ? "cursor-col-resize" : "cursor-row-resize"}
					/>
					<div
						className={`
            ${isHorizontal ? "w-0.5 h-8" : "h-0.5 w-8"}
            bg-gray-500 rounded-full pointer-events-none
          `}
					/>
				</div>,
			);
		}
	});

	return (
		<div
			ref={containerRef}
			className={`h-full w-full flex select-none ${isHorizontal ? "flex-row" : "flex-col"}`}
		>
			{elements}
		</div>
	);
}
