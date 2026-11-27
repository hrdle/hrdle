/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import hljs from "highlight.js";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import "highlight.js/styles/github-dark.css";
import { useLineSelection } from "../../hooks/useLineSelection";
import { usePinchZoom } from "../../hooks/usePinchZoom";
import { useScrollRatio } from "../../hooks/useScrollRatio";
import {
	MAX_FONTSIZE,
	MIN_FONTSIZE,
	useViewerSettings,
} from "../../hooks/useViewerSettings";
import { splitHighlightedHtml } from "../../utils/highlight";
import { PromptComposer } from "./PromptComposer";

interface CodeViewerProps {
	content: string;
	language?: string;
	fileName?: string;
	filePath?: string;
	showLineNumbers?: boolean;
	truncated?: boolean;
	onCopyPrompt?: (text: string) => void;
	initialScrollRatio?: number;
	onScrollRatioChange?: (ratio: number) => void;
}

export function CodeViewer({
	content,
	language = "plaintext",
	fileName,
	filePath,
	showLineNumbers = true,
	truncated = false,
	onCopyPrompt,
	initialScrollRatio = 0,
	onScrollRatioChange,
}: CodeViewerProps) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const { wordWrap, fontSize, setFontSize, commitFontSize } =
		useViewerSettings(fileName);
	const { selection, handleLineClick, isLineSelected, clearSelection } =
		useLineSelection();

	usePinchZoom({
		ref: containerRef,
		value: fontSize,
		min: MIN_FONTSIZE,
		max: MAX_FONTSIZE,
		onChange: setFontSize,
		onCommit: commitFontSize,
	});

	useScrollRatio({
		ref: containerRef,
		initialRatio: initialScrollRatio,
		onChange: onScrollRatioChange,
	});

	// Highlight and split into per-line HTML
	const highlightedLines = useMemo(() => {
		const rawLines = content.split("\n");
		if (language === "plaintext" || !hljs.getLanguage(language)) {
			return rawLines.map((l) => ({ text: l, html: null }));
		}
		try {
			const result = hljs.highlight(content, {
				language,
				ignoreIllegals: true,
			});
			const htmlLines = splitHighlightedHtml(result.value);
			return rawLines.map((text, i) => ({ text, html: htmlLines[i] ?? null }));
		} catch {
			return rawLines.map((l) => ({ text: l, html: null }));
		}
	}, [content, language]);

	return (
		<div className="relative flex flex-col h-full bg-th-bg text-th-text font-mono text-sm">
			{/* Truncation warning */}
			{truncated && (
				<div className="px-3 py-1.5 bg-yellow-900/50 text-yellow-300 text-xs border-b border-yellow-800">
					{t("files.fileTooLarge")}
				</div>
			)}

			{/* Code content */}
			<div ref={containerRef} className="flex-1 overflow-auto touch-pan-y">
				<div className={`min-h-full ${wordWrap ? "" : "min-w-fit"}`}>
					{highlightedLines.map((line, i) => {
						const lineNum = i + 1;
						const selected = isLineSelected(lineNum);
						return (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: line index is the natural key for source-code rendering
								key={i}
								className={`flex ${selected ? "bg-blue-900/30" : ""} ${onCopyPrompt ? "cursor-pointer select-none" : ""}`}
								onClick={
									onCopyPrompt ? () => handleLineClick(lineNum) : undefined
								}
								onContextMenu={
									onCopyPrompt ? (e) => e.preventDefault() : undefined
								}
								style={
									onCopyPrompt ? { WebkitTouchCallout: "none" } : undefined
								}
							>
								{/* Line number */}
								{showLineNumbers && (
									<div
										className={`shrink-0 select-none text-right border-r border-th-border sticky left-0 px-1.5 ${
											selected
												? "bg-blue-800/40 text-blue-300"
												: "bg-th-surface/50 text-th-text-muted"
										}`}
										style={{
											fontSize: `${Math.max(10, fontSize - 2)}px`,
											lineHeight: `${fontSize * 1.5}px`,
											minWidth: "2.5rem",
										}}
									>
										{lineNum}
									</div>
								)}

								{/* Code line */}
								<pre
									className={`flex-1 m-0 px-2 ${wordWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}
									style={{
										fontSize: `${fontSize}px`,
										lineHeight: `${fontSize * 1.5}px`,
									}}
								>
									{line.html ? (
										<code
											// biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered highlight.js HTML
											dangerouslySetInnerHTML={{
												__html: line.html || "&nbsp;",
											}}
										/>
									) : (
										<code>{line.text || " "}</code>
									)}
								</pre>
							</div>
						);
					})}
				</div>
			</div>

			{/* Prompt Composer */}
			{selection && onCopyPrompt && (
				<PromptComposer
					filePath={filePath || fileName || "unknown"}
					startLine={selection.start}
					endLine={selection.end}
					selectedCode={highlightedLines
						.slice(selection.start - 1, selection.end)
						.map((l) => l.text)
						.join("\n")}
					language={language}
					onSubmit={(text) => {
						onCopyPrompt(text);
						clearSelection();
					}}
					onClose={clearSelection}
				/>
			)}
		</div>
	);
}
