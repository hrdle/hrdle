import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ConversationMessage,
	HistorySession,
	SessionResponse,
} from "../../../shared/types";
import type { useSessionHistory } from "./useSessionHistory";
import { authFetch } from "../services/api";

const API_BASE = import.meta.env.VITE_API_URL || "";

// Active session carries the Claude Code session id used to match history rows.
interface ActiveSession extends SessionResponse {
	ccSessionId?: string;
}

interface UseHistoryActionsArgs {
	activeSessions: ActiveSession[];
	onSelectSession?: (session: SessionResponse) => void;
	onSessionResumed?: () => void;
	resumeSession: ReturnType<typeof useSessionHistory>["resumeSession"];
	fetchConversation: ReturnType<typeof useSessionHistory>["fetchConversation"];
	refreshAllLoadedProjects: ReturnType<
		typeof useSessionHistory
	>["refreshAllLoadedProjects"];
}

/**
 * Resume / navigate / open-conversation behavior shared by the history views.
 * Extracted from the V1 SessionHistory so the V2 (faceted) view can reuse the
 * exact same resume sequence, active-session matching, and modal lifecycle.
 *
 * NOTE: V1 still has its own inline copy of this logic; both are kept until V1
 * is removed (PR6), at which point only this hook remains.
 */
export function useHistoryActions({
	activeSessions,
	onSelectSession,
	onSessionResumed,
	resumeSession,
	fetchConversation,
	refreshAllLoadedProjects,
}: UseHistoryActionsArgs) {
	const { t } = useTranslation();

	// useSessionHistory recreates these callbacks whenever sessionsByProject /
	// loadingProjects change (i.e. on every project load during hydration). Hold
	// them in refs so the handlers below keep a stable identity and don't churn
	// the (virtualized) rows' props mid-hydration.
	const resumeRef = useRef(resumeSession);
	resumeRef.current = resumeSession;
	const fetchConvRef = useRef(fetchConversation);
	fetchConvRef.current = fetchConversation;
	const refreshRef = useRef(refreshAllLoadedProjects);
	refreshRef.current = refreshAllLoadedProjects;
	const selectRef = useRef(onSelectSession);
	selectRef.current = onSelectSession;
	const resumedRef = useRef(onSessionResumed);
	resumedRef.current = onSessionResumed;

	const [resumingId, setResumingId] = useState<string | null>(null);
	const [resumeError, setResumeError] = useState<string | null>(null);
	const [selectedSession, setSelectedSession] =
		useState<HistorySession | null>(null);
	const [conversation, setConversation] = useState<ConversationMessage[]>([]);
	const [loadingConversation, setLoadingConversation] = useState(false);

	const activeCcSessionIds = useMemo(() => {
		const ids = new Set<string>();
		for (const s of activeSessions) {
			if (s.ccSessionId) ids.add(s.ccSessionId);
		}
		return ids;
	}, [activeSessions]);

	const sessionsByCcId = useMemo(() => {
		const map = new Map<string, SessionResponse[]>();
		for (const s of activeSessions) {
			if (s.ccSessionId) {
				const list = map.get(s.ccSessionId) || [];
				list.push(s);
				map.set(s.ccSessionId, list);
			}
		}
		return map;
	}, [activeSessions]);

	const findActiveSession = useCallback(
		(historySession: HistorySession): SessionResponse | undefined => {
			const candidates = sessionsByCcId.get(historySession.sessionId);
			if (!candidates || candidates.length === 0) return undefined;
			if (candidates.length === 1) return candidates[0];
			const projectBasename =
				historySession.projectPath.split("/").pop() || "";
			return (
				candidates.find((s) => s.name === projectBasename) || candidates[0]
			);
		},
		[sessionsByCcId],
	);

	const handleResume = useCallback(
		async (session: HistorySession) => {
			setResumingId(session.sessionId);
			setResumeError(null);
			try {
				const result = await resumeRef.current(
					session.sessionId,
					session.projectPath,
					session.agent,
					session.peerId,
				);

				if (result) {
					await new Promise((resolve) => setTimeout(resolve, 1000));

					const response = await authFetch(`${API_BASE}/api/workspaces`);
					let foundSession: SessionResponse | undefined;
					if (response.ok) {
						const data = await response.json();
						foundSession = data.sessions?.find(
							(s: { id: string }) => s.id === result.tmuxSessionId,
						);
					}

					if (selectRef.current && foundSession)
						selectRef.current(foundSession);
					if (resumedRef.current) resumedRef.current();
					await refreshRef.current();
				}
				setSelectedSession(null);
			} catch (err) {
				const error = err as Error & {
					data?: { error?: string; existingSession?: string };
				};
				if (error.data?.error === "duplicate_working_dir") {
					setResumeError(
						t("session.duplicateWorkingDir", {
							name: error.data.existingSession || "",
						}),
					);
				} else {
					setResumeError(t("session.resumeFailed"));
				}
			} finally {
				setResumingId(null);
			}
		},
		[t],
	);

	const handleNavigate = useCallback(
		(session: HistorySession) => {
			const activeSession = findActiveSession(session);
			if (activeSession && selectRef.current) {
				selectRef.current(activeSession);
				if (resumedRef.current) resumedRef.current();
			}
		},
		[findActiveSession],
	);

	const handleTap = useCallback(
		async (session: HistorySession, projectDirName?: string) => {
			setResumeError(null);
			setSelectedSession(session);
			setLoadingConversation(true);
			setConversation([]);
			try {
				const messages = await fetchConvRef.current(
					session.sessionId,
					projectDirName,
					session.agent,
					session.peerId,
				);
				setConversation(messages);
			} finally {
				setLoadingConversation(false);
			}
		},
		[],
	);

	const closeModal = useCallback(() => setSelectedSession(null), []);
	const dismissError = useCallback(() => setResumeError(null), []);

	return {
		resumingId,
		resumeError,
		selectedSession,
		conversation,
		loadingConversation,
		activeCcSessionIds,
		findActiveSession,
		handleResume,
		handleNavigate,
		handleTap,
		closeModal,
		dismissError,
	};
}
