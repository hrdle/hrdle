import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../services/api";
import { paneUrl } from "./pane-url";

export interface QuestionOption {
	index: number;
	label: string;
	description?: string;
	checked?: boolean;
	freeText?: boolean;
	/** With `freeText`: a tap chooses it without words. */
	textOptional?: boolean;
}

export interface PaneQuestion {
	questionId: string;
	question: string;
	multiSelect: boolean;
	options: QuestionOption[];
	kind?: "permission";
	/** Permission only: the tool asking (`Bash command`) and what it will do. */
	title?: string;
	detail?: string;
}

type QuestionRead =
	| { status: "question"; question: PaneQuestion }
	| { status: "none" | "not-blocked" | "unsupported" | "ambiguous" };

/** How often the question is read again while the pane waits on one. */
const REREAD_MS = 4000;

/**
 * The question a pane is waiting on, read through the same API the glasses
 * answer with. Read only while the pane reports it is waiting, and read again
 * every few seconds then: a call with several questions moves to the next one
 * on the pane without the status changing.
 */
export function usePaneQuestion(
	sessionId: string,
	paneId: string,
	peerId: string | undefined,
	waiting: boolean,
) {
	const [question, setQuestion] = useState<PaneQuestion | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const apply = useCallback((read: QuestionRead | undefined) => {
		setQuestion(read?.status === "question" ? read.question : null);
	}, []);

	useEffect(() => {
		if (!waiting) {
			setQuestion(null);
			setError(null);
			return;
		}
		let cancelled = false;
		const read = async () => {
			try {
				const res = await authFetch(paneUrl(sessionId, paneId, peerId, "question"));
				if (!res.ok || cancelled) return;
				apply((await res.json()) as QuestionRead);
			} catch {
				// A failed read leaves the card as it was; the next one decides.
			}
		};
		void read();
		const timer = setInterval(read, REREAD_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [sessionId, paneId, peerId, waiting, apply]);

	const answer = useCallback(
		async (choices: number[], text?: string): Promise<boolean> => {
			if (!question) return false;
			setBusy(true);
			setError(null);
			try {
				const res = await authFetch(paneUrl(sessionId, paneId, peerId, "answer"), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ questionId: question.questionId, choices, text }),
				});
				const data = await res.json().catch(() => ({}));
				if (!res.ok) {
					// A 409 carries the question as the pane shows it now.
					if (data.current) apply(data.current);
					throw new Error(data.error || `status ${res.status}`);
				}
				apply(data.next);
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			} finally {
				setBusy(false);
			}
		},
		[question, sessionId, paneId, peerId, apply],
	);

	return { question, answer, busy, error };
}
