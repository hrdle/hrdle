import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AgentProvider,
	ConversationMessage,
	HistorySession,
	PeerHistoryProject,
	PeerHistoryProjectsResponse,
} from "../../../shared/types";
import { LOCAL_PEER_ID } from "../../../shared/types";
import { authFetch, getAuthToken, isTransientNetworkError } from "../services/api";

const API_BASE = import.meta.env.VITE_API_URL || "";

// Multi-server: the internal key is `${peerId}::${dirName}`, because dirName can
// collide across peers. The UI keys its expand state off the same thing.
export type ProjectKey = string;
export function projectKey(peerId: string, dirName: string): ProjectKey {
	return `${peerId}::${dirName}`;
}

export type ProjectInfo = PeerHistoryProject;

interface UseSessionHistoryResult {
	projects: ProjectInfo[];
	isLoadingProjects: boolean;

	sessionsByProject: Map<ProjectKey, HistorySession[]>;
	loadingProjects: Set<ProjectKey>;
	fetchProjectSessions: (
		peerId: string,
		dirName: string,
		forceRefresh?: boolean,
	) => Promise<void>;
	refreshAllLoadedProjects: () => Promise<void>;

	searchResults: HistorySession[];
	isSearching: boolean;
	searchQuery: string;
	searchSessions: (query: string) => Promise<void>;
	clearSearch: () => void;

	error: string | null;

	refresh: () => Promise<void>;
	resumeSession: (
		sessionId: string,
		projectPath: string,
		agent?: AgentProvider,
		peerId?: string,
	) => Promise<{ tmuxSessionId: string } | null>;
	fetchConversation: (
		sessionId: string,
		projectDirName?: string,
		agent?: AgentProvider,
		peerId?: string,
	) => Promise<ConversationMessage[]>;
}

export function useSessionHistory(): UseSessionHistoryResult {
	const [projects, setProjects] = useState<ProjectInfo[]>([]);
	const [isLoadingProjects, setIsLoadingProjects] = useState(true);
	const [sessionsByProject, setSessionsByProject] = useState<
		Map<ProjectKey, HistorySession[]>
	>(new Map());
	const [loadingProjects, setLoadingProjects] = useState<Set<ProjectKey>>(
		new Set(),
	);
	const [error, setError] = useState<string | null>(null);

	const [searchResults, setSearchResults] = useState<HistorySession[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");

	// Fetch the project list of every peer
	const fetchProjects = useCallback(async (silent = false) => {
		try {
			if (!silent) {
				setIsLoadingProjects(true);
				setError(null);
			}
			const response = await authFetch(
				`${API_BASE}/api/peers/history/projects`,
			);
			if (!response.ok) {
				throw new Error("Failed to fetch projects");
			}
			const data = (await response.json()) as PeerHistoryProjectsResponse;
			setProjects((prev) => {
				const newJson = JSON.stringify(data.projects || []);
				const prevJson = JSON.stringify(prev);
				return newJson === prevJson ? prev : data.projects || [];
			});
		} catch (err) {
			if (!silent && !isTransientNetworkError(err)) {
				setError(err instanceof Error ? err.message : "Unknown error");
			}
		} finally {
			if (!silent) {
				setIsLoadingProjects(false);
			}
		}
	}, []);

	const fetchProjectSessions = useCallback(
		async (peerId: string, dirName: string, forceRefresh = false) => {
			const key = projectKey(peerId, dirName);
			if (
				!forceRefresh &&
				(sessionsByProject.has(key) || loadingProjects.has(key))
			) {
				return;
			}

			try {
				setLoadingProjects((prev) => new Set(prev).add(key));
				const response = await authFetch(
					`${API_BASE}/api/peers/history/${encodeURIComponent(peerId)}/projects/${encodeURIComponent(dirName)}`,
				);
				if (!response.ok) {
					throw new Error("Failed to fetch project sessions");
				}
				const data = (await response.json()) as { sessions?: HistorySession[] };
				setSessionsByProject((prev) => {
					const next = new Map(prev);
					next.set(key, data.sessions ?? []);
					return next;
				});
			} catch (err) {
				console.error("Failed to fetch project sessions:", err);
			} finally {
				setLoadingProjects((prev) => {
					const next = new Set(prev);
					next.delete(key);
					return next;
				});
			}
		},
		[sessionsByProject, loadingProjects],
	);

	const refreshAllLoadedProjects = useCallback(async () => {
		const loadedKeys = Array.from(sessionsByProject.keys());
		setSessionsByProject(new Map());
		await Promise.all(
			loadedKeys.map((key) => {
				const [peerId, dirName] = key.split("::");
				return fetchProjectSessions(peerId, dirName, true);
			}),
		);
	}, [sessionsByProject, fetchProjectSessions]);

	const resumeSession = useCallback(
		async (
			sessionId: string,
			projectPath: string,
			agent?: AgentProvider,
			peerId?: string,
		) => {
			try {
				const isRemote = peerId && peerId !== LOCAL_PEER_ID;
				const url = isRemote
					? `${API_BASE}/api/peers/history/${encodeURIComponent(peerId)}/resume`
					: `${API_BASE}/api/sessions/history/resume`;
				const response = await authFetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId, projectPath, agent }),
				});
				if (!response.ok) {
					const errorData = await response.json().catch(() => ({}));
					const err = new Error(errorData.error || "Failed to resume session");
					(err as Error & { data?: unknown }).data = errorData;
					throw err;
				}
				const data = await response.json();
				return { tmuxSessionId: data.tmuxSessionId };
			} catch (err) {
				console.error("Failed to resume session:", err);
				throw err;
			}
		},
		[],
	);

	const fetchConversation = useCallback(
		async (
			sessionId: string,
			projectDirName?: string,
			agent?: AgentProvider,
			peerId?: string,
		): Promise<ConversationMessage[]> => {
			try {
				const isRemote = peerId && peerId !== LOCAL_PEER_ID;
				const base = isRemote
					? `${API_BASE}/api/peers/history/${encodeURIComponent(peerId)}/${encodeURIComponent(sessionId)}/conversation`
					: `${API_BASE}/api/sessions/history/${encodeURIComponent(sessionId)}/conversation`;
				const url = new URL(base, window.location.origin);
				if (projectDirName) {
					url.searchParams.set("projectDirName", projectDirName);
				}
				// Thread agents (codex, grok, ...) read from their own transcript
				// store; Claude stays on the default jsonl path.
				if (agent && agent !== "claude") {
					url.searchParams.set("agent", agent);
				}
				const response = await authFetch(url.toString(), { cache: "no-store" });
				if (!response.ok) {
					throw new Error("Failed to fetch conversation");
				}
				const data = await response.json();
				return data.messages || [];
			} catch (err) {
				console.error("Failed to fetch conversation:", err);
				return [];
			}
		},
		[],
	);

	// Search uses the hub's own SSE (cross-peer search is not implemented yet).
	// EventSource cannot send an Authorization header and fails silently with 401
	// under password auth, so the Bearer goes through fetch + ReadableStream and the
	// SSE is parsed by hand. An AbortController closes the previous stream on a
	// repeated search or unmount.
	const searchAbortRef = useRef<AbortController | null>(null);
	const searchSessions = useCallback(async (query: string) => {
		setSearchQuery(query);
		searchAbortRef.current?.abort();
		if (!query.trim()) {
			setSearchResults([]);
			setIsSearching(false);
			return;
		}

		setIsSearching(true);
		setSearchResults([]);

		const controller = new AbortController();
		searchAbortRef.current = controller;
		try {
			const url = `${API_BASE}/api/sessions/history/search/stream?q=${encodeURIComponent(query)}`;
			const token = getAuthToken();
			const headers: Record<string, string> = {};
			if (token) headers.Authorization = `Bearer ${token}`;
			const res = await fetch(url, { headers, signal: controller.signal });
			if (!res.ok || !res.body) {
				console.error(`Session search failed: HTTP ${res.status}`);
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let streaming = true;
			while (streaming) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let sep = buffer.indexOf("\n\n");
				while (sep !== -1) {
					const frame = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);
					let eventType = "message";
					const dataLines: string[] = [];
					for (const line of frame.split("\n")) {
						if (line.startsWith("event:")) eventType = line.slice(6).trim();
						else if (line.startsWith("data:"))
							dataLines.push(line.slice(5).replace(/^ /, ""));
					}
					const data = dataLines.join("\n");
					if (eventType === "done") {
						streaming = false;
						break;
					}
					if (eventType === "error") {
						console.error("Session search stream reported an error");
					} else if (data) {
						try {
							setSearchResults((prev) => [
								...prev,
								JSON.parse(data) as HistorySession,
							]);
						} catch {
							/* Ignore parse errors */
						}
					}
					sep = buffer.indexOf("\n\n");
				}
			}
		} catch (err) {
			if (!(err instanceof DOMException && err.name === "AbortError")) {
				console.error("Failed to search sessions:", err);
			}
		} finally {
			if (searchAbortRef.current === controller) {
				searchAbortRef.current = null;
				setIsSearching(false);
			}
		}
	}, []);

	// Abort any in-flight search stream on unmount (also closes the stream
	// across repeated searches, fixing the old EventSource leak).
	useEffect(() => () => searchAbortRef.current?.abort(), []);

	const clearSearch = useCallback(() => {
		setSearchQuery("");
		setSearchResults([]);
	}, []);

	useEffect(() => {
		fetchProjects();
	}, [fetchProjects]);

	return {
		projects,
		isLoadingProjects,
		sessionsByProject,
		loadingProjects,
		fetchProjectSessions,
		refreshAllLoadedProjects,
		searchResults,
		isSearching,
		searchQuery,
		searchSessions,
		clearSearch,
		error,
		refresh: fetchProjects,
		resumeSession,
		fetchConversation,
	};
}
