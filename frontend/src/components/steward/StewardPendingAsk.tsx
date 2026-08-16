import { useCallback, useEffect, useState } from "react";
import type { StewardThreadItem } from "../../../../shared/types";
import { authFetch } from "../../services/api";
import { AskControls } from "./AskControls";

const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * A question about this session, above the composer.
 *
 * The thread carries every waiting question, but somebody reading a session is
 * not there - and a question they never see is one the steward waits on
 * forever. So it is asked where they are, and answering it here is the same
 * answer.
 */
export function StewardPendingAsk({ sessionId }: { sessionId: string }) {
	const [asks, setAsks] = useState<StewardThreadItem[]>([]);

	const load = useCallback(async () => {
		const res = await authFetch(
			`${API_BASE}/api/steward/asks?session=${encodeURIComponent(sessionId)}`,
		);
		if (!res.ok) return;
		setAsks(((await res.json()) as { asks?: StewardThreadItem[] }).asks ?? []);
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
		await authFetch(`${API_BASE}/api/steward/thread/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...input, sessionId }),
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
