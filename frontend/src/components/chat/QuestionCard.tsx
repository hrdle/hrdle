import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PaneQuestion } from "./usePaneQuestion";

interface QuestionCardProps {
	question: PaneQuestion;
	busy: boolean;
	error: string | null;
	onAnswer: (choices: number[], text?: string) => void;
	/** A single choice's free-text row was chosen: its words are written in the composer. */
	onWrite: () => void;
}

/**
 * The question the pane waits on, above the composer. A single choice answers
 * on tap; a multi-select is ticked here and sent with its own button, because
 * a tap that also sent would leave no way to pick a second box. A multi-select's
 * free-text row takes its words in the card, since they go with the ticks.
 */
export function QuestionCard({ question, busy, error, onAnswer, onWrite }: QuestionCardProps) {
	const { t } = useTranslation();
	const [ticked, setTicked] = useState<Set<number>>(new Set());
	const [fieldText, setFieldText] = useState("");
	const fieldOption = question.multiSelect
		? question.options.find((o) => o.freeText)
		: undefined;
	const fieldTicked = fieldOption ? ticked.has(fieldOption.index) : false;

	useEffect(() => {
		setTicked(
			new Set(question.options.filter((o) => o.checked).map((o) => o.index)),
		);
		setFieldText("");
	}, [question.questionId, question.options]);

	return (
		<div
			className="mx-auto mb-2 flex max-h-[45vh] max-w-3xl flex-col overflow-hidden rounded-2xl border border-cv-text-muted/40 bg-cv-surface"
			data-testid="chat-question"
		>
			<div className="flex items-center gap-2 px-3.5 pt-2.5">
				<span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
				<span className="text-cv-text-muted text-xs">
					{t(
						question.kind === "permission"
							? "conversation.permissionWaiting"
							: "conversation.questionWaiting",
					)}
				</span>
			</div>
			<div className="min-h-0 overflow-y-auto">
			{question.kind === "permission" && question.title && (
				<div className="px-3.5 pt-1 text-cv-text-secondary text-xs">{question.title}</div>
			)}
			{question.detail && (
				<pre className="mx-3.5 mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-cv-border bg-cv-bg px-2.5 py-2 font-mono text-[12.5px] text-cv-text-secondary leading-snug">
					{question.detail}
				</pre>
			)}
			<div className="px-3.5 pt-1.5 pb-2 font-medium text-[15px] text-cv-text whitespace-pre-wrap">
				{question.question}
			</div>
			<div>
				{question.options.map((option, i) => {
					const isTicked = ticked.has(option.index);
					return (
						<div key={option.index}>
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								if (option.freeText && !option.textOptional && !question.multiSelect) {
									onWrite();
									return;
								}
								if (!question.multiSelect) {
									onAnswer([option.index]);
									return;
								}
								setTicked((prev) => {
									const next = new Set(prev);
									if (next.has(option.index)) next.delete(option.index);
									else next.add(option.index);
									return next;
								});
							}}
							className="flex w-full items-start gap-3 border-cv-border border-t px-3.5 py-2.5 text-left hover:bg-cv-surface-hover disabled:opacity-50"
						>
							<span
								className={`mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center border text-xs ${
									question.multiSelect ? "rounded-md" : "rounded-full"
								} ${
									isTicked
										? "border-cv-accent bg-cv-accent text-white"
										: "border-cv-text-muted/50 text-cv-text-secondary"
								}`}
							>
								{!question.multiSelect ? (
									i + 1
								) : isTicked ? (
									<svg
										className="h-3.5 w-3.5"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth={3}
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										<path d="M5 12l5 5 9-10" />
									</svg>
								) : null}
							</span>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="text-[15px] text-cv-text">{option.label}</span>
								{option.description && (
									<span className="text-cv-text-muted text-xs">
										{option.description}
									</span>
								)}
								{option.textOptional && (
									<span className="text-cv-text-muted text-xs">
										{t("conversation.permissionDenyHint")}
									</span>
								)}
							</span>
						</button>
						{option.freeText && question.multiSelect && isTicked && (
							<div className="px-3.5 pb-2.5 pl-[50px]">
								<input
									value={fieldText}
									onChange={(e) => setFieldText(e.target.value)}
									lang="ja"
									aria-label={option.label}
									placeholder={t("conversation.questionWriteAnswer")}
									className="w-full rounded-lg border border-cv-border bg-cv-bg px-2.5 py-1.5 text-cv-text placeholder:text-cv-text-muted focus:outline-none"
									style={{ fontSize: "16px" }}
								/>
							</div>
						)}
						</div>
					);
				})}
			</div>
			</div>
			{question.multiSelect && (
				<div className="flex justify-end border-cv-border border-t px-3 py-2">
					<button
						type="button"
						disabled={
							busy || ticked.size === 0 || (fieldTicked && !fieldText.trim())
						}
						onClick={() =>
							onAnswer(
								[...ticked].sort((a, b) => a - b),
								fieldTicked ? fieldText.trim() : undefined,
							)
						}
						className="rounded-full bg-cv-accent px-4 py-1.5 text-sm text-white disabled:opacity-40"
					>
						{t("conversation.questionSubmit")}
					</button>
				</div>
			)}
			{error && (
				<div className="border-cv-border border-t px-3.5 py-2 text-red-400 text-xs" role="alert">
					{t("conversation.questionFailed", { reason: error })}
				</div>
			)}
		</div>
	);
}
