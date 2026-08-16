import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { StewardAsk } from "../../../../shared/types";

/**
 * The choices for one question.
 *
 * Shared by the thread, where a question sits in the conversation, and a
 * session's chat, where it sits above the composer - a question is answered
 * where the person is looking, not only where it happened to be recorded.
 */
export function AskControls({
	ask,
	onAnswer,
}: {
	ask: StewardAsk;
	onAnswer: (input: { askId: string; answer: { kind: "choice"; indices: number[] } | { kind: "dismissed" } }) => void;
}) {
	const { t } = useTranslation();
	const [picked, setPicked] = useState<number[]>([]);

	if (ask.answer) {
		const said =
			ask.answer.kind === "choice"
				? ask.answer.indices.map((i) => ask.choices[i] ?? `#${i}`).join(", ")
				: ask.answer.kind === "text"
					? ask.answer.text
					: t("steward.dismissed", "dismissed");
		return <p className="mt-2 text-cv-text-muted text-xs">{t("steward.answered", "Answered")}: {said}</p>;
	}

	const multi = ask.mode === "multi";

	return (
		<div className="mt-2 flex flex-col gap-1">
			{ask.step && (
				<p className="text-cv-text-muted text-xs">
					{ask.step.index} / {ask.step.total}
				</p>
			)}
			{ask.choices.map((choice, index) => {
				const on = picked.includes(index);
				return (
					<button
						key={choice}
						type="button"
						onClick={() => {
							if (!multi) {
								onAnswer({ askId: ask.id, answer: { kind: "choice", indices: [index] } });
								return;
							}
							setPicked((prev) => (on ? prev.filter((i) => i !== index) : [...prev, index]));
						}}
						className={`rounded-lg px-3 py-2 text-left text-sm ${
							on ? "bg-cv-surface-hover" : "bg-cv-bg hover:bg-cv-surface-hover"
						}`}
					>
						{choice}
					</button>
				);
			})}
			<div className="flex gap-2">
				{multi && (
					<button
						type="button"
						disabled={picked.length === 0}
						onClick={() => onAnswer({ askId: ask.id, answer: { kind: "choice", indices: picked } })}
						className="min-h-[32px] rounded-lg bg-cv-surface-hover px-3 py-1.5 text-xs disabled:opacity-40"
					>
						{t("common.send", "Send")}
					</button>
				)}
				{/* Walking away is an answer: without it the steward waits forever. */}
				<button
					type="button"
					onClick={() => onAnswer({ askId: ask.id, answer: { kind: "dismissed" } })}
					className="min-h-[32px] rounded-lg px-3 py-1.5 text-cv-text-muted text-xs hover:text-cv-text"
				>
					{t("steward.dismiss", "Not now")}
				</button>
			</div>
		</div>
	);
}
