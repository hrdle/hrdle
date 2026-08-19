import { useCallback, useEffect, useState } from "react";
import type { StewardThreadItem } from "../../../../shared/types";
import { authFetch } from "../../services/api";
import { AskControls } from "./AskControls";

const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * A question waiting on an answer, above the composer.
 *
 * The thread carries every waiting question, but somebody reading a session is
 * not there - and a question they never see is one the steward waits on
 * forever. So it is asked where they are, and answering it here is the same
 * answer.
 *
 * **This session's, and any that belong to no session.** A question the steward
 * raises about nothing in particular - which way to do something, whether to go
 * ahead - carries no `sessionId`, and until now that meant it appeared on no
 * session screen at all. Its only home was the thread, which is a screen you
 * have to go to on purpose. Measured on 2026-08-19: two such questions sat
 * unanswered for five hours while the person they were for was in the app the
 * whole time, and the server never saw an answer attempt for either. They were
 * not ignored; they were never on screen.
 */
export function StewardPendingAsk({ sessionId }: { sessionId?: string }) {
	const [asks, setAsks] = useState<StewardThreadItem[]>([]);

	const load = useCallback(async () => {
		// Every pending question, narrowed here: the endpoint filters to one
		// session or to none at all, and what this screen wants is "mine, plus
		// the ones that are nobody's".
		const res = await authFetch(`${API_BASE}/api/steward/asks`);
		if (!res.ok) return;
		const all = ((await res.json()) as { asks?: StewardThreadItem[] }).asks ?? [];
		setAsks(all.filter((item) => !item.sessionId || item.sessionId === sessionId));
	}, [sessionId]);

	useEffect(() => {
		let alive = true;
		const tick = () => {
			if (alive) void load();
		};
		tick();
		const timer = setInterval(tick, 5000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [load]);

	const answer = async (input: {
		askId: string;
		answer: { kind: "choice"; indices: number[] } | { kind: "dismissed" };
	}) => {
		// The question's own session, not the screen's. A question that belongs
		// to nobody, answered from a session, would otherwise be filed under
		// whichever screen happened to be open.
		const about = asks.find((item) => item.kind === "ask" && item.ask.id === input.askId)?.sessionId;
		await authFetch(`${API_BASE}/api/steward/thread/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...input, ...(about ? { sessionId: about } : {}) }),
		});
		await load();
	};

	if (asks.length === 0) return null;

	return (
		<div className="border-cv-border border-t bg-cv-bg px-3 py-2">
			{asks.map((item) =>
				item.kind === "ask" ? (
					<div key={item.id}>
						<p className="text-cv-text text-sm">{item.text}</p>
						<AskControls ask={item.ask} onAnswer={answer} />
					</div>
				) : null,
			)}
		</div>
	);
}
