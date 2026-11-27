import hljs from "highlight.js";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/github-dark.css";
import { usePinchZoom } from "../../hooks/usePinchZoom";
import { handleExternalLinkClick } from "../../utils/link-menu";
import { useScrollRatio } from "../../hooks/useScrollRatio";
import {
	MAX_FONTSIZE,
	MIN_FONTSIZE,
	useViewerSettings,
} from "../../hooks/useViewerSettings";

interface MarkdownViewerProps {
	content: string;
	truncated?: boolean;
	initialScrollRatio?: number;
	onScrollRatioChange?: (ratio: number) => void;
	filePath?: string;
	sessionWorkingDir?: string;
	/** API prefix matching the peer (`/api/files` or `/api/peers/<id>/files`). */
	filesApiBase?: string;
}

function resolveImageSrc(
	src: string,
	filesApiBase: string,
	filePath?: string,
	sessionWorkingDir?: string,
): string {
	if (!src) return src;
	// Absolute URL or data/blob — pass through
	if (/^(https?:\/\/|data:|blob:|\/\/)/.test(src)) return src;
	if (!filePath || !sessionWorkingDir) return src;

	let absPath: string;
	if (src.startsWith("/")) {
		absPath = src;
	} else {
		const dir = filePath.replace(/\/[^/]*$/, "");
		const parts = dir.split("/");
		for (const segment of src.split("/")) {
			if (segment === "..") parts.pop();
			else if (segment !== "." && segment !== "") parts.push(segment);
		}
		absPath = parts.join("/");
	}
	return `${filesApiBase}/raw?path=${encodeURIComponent(absPath)}&sessionWorkingDir=${encodeURIComponent(sessionWorkingDir)}`;
}

export function MarkdownViewer({
	content,
	truncated = false,
	initialScrollRatio = 0,
	onScrollRatioChange,
	filePath,
	sessionWorkingDir,
	filesApiBase = "/api/files",
}: MarkdownViewerProps) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const { fontSize, setFontSize, commitFontSize } =
		useViewerSettings();

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

	// Memoized so font-size changes (which re-render the container) don't force
	// react-markdown to re-parse the whole document.
	const renderedMarkdown = useMemo(
		() => (
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					pre: ({ children }) => (
						<pre className="bg-th-surface p-3 rounded-md overflow-x-auto my-3 text-sm">
							{children}
						</pre>
					),
					code: ({ children, className }) => {
						const match = /language-(\w+)/.exec(className || "");
						const lang = match?.[1];
						const isBlock = Boolean(className);

						if (isBlock && lang && hljs.getLanguage(lang)) {
							const highlighted = hljs.highlight(
								String(children).replace(/\n$/, ""),
								{ language: lang },
							);
							return (
								<code
									className={`hljs language-${lang}`}
									// biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js produces escaped HTML
									dangerouslySetInnerHTML={{ __html: highlighted.value }}
								/>
							);
						}

						return isBlock ? (
							<code className="text-green-300">{children}</code>
						) : (
							<code className="bg-th-surface-hover px-1.5 py-0.5 rounded text-blue-300 text-sm">
								{children}
							</code>
						);
					},
					p: ({ children }) => (
						<p className="my-3 leading-relaxed">{children}</p>
					),
					ul: ({ children }) => (
						<ul className="list-disc ml-5 my-3 space-y-1">{children}</ul>
					),
					ol: ({ children }) => (
						<ol className="list-decimal ml-5 my-3 space-y-1">{children}</ol>
					),
					li: ({ children }) => <li className="leading-relaxed">{children}</li>,
					h1: ({ children }) => (
						<h1 className="text-2xl font-bold my-4 pb-2 border-b border-th-border">
							{children}
						</h1>
					),
					h2: ({ children }) => (
						<h2 className="text-xl font-bold my-4 pb-1 border-b border-th-border">
							{children}
						</h2>
					),
					h3: ({ children }) => (
						<h3 className="text-lg font-bold my-3">{children}</h3>
					),
					h4: ({ children }) => (
						<h4 className="text-base font-bold my-2">{children}</h4>
					),
					h5: ({ children }) => (
						<h5 className="text-sm font-bold my-2">{children}</h5>
					),
					h6: ({ children }) => (
						<h6 className="text-sm font-bold my-2 text-th-text-secondary">
							{children}
						</h6>
					),
					strong: ({ children }) => (
						<strong className="font-bold text-th-text">{children}</strong>
					),
					em: ({ children }) => <em className="italic">{children}</em>,
					a: ({ href, children }) => (
						<a
							href={href}
							className="text-blue-400 hover:text-blue-300 underline"
							target="_blank"
							rel="noopener noreferrer"
							onClick={handleExternalLinkClick}
						>
							{children}
						</a>
					),
					blockquote: ({ children }) => (
						<blockquote className="border-l-4 border-th-border pl-4 my-3 text-th-text-secondary italic">
							{children}
						</blockquote>
					),
					hr: () => <hr className="my-6 border-th-border" />,
					table: ({ children }) => (
						<div className="overflow-x-auto my-4">
							<table className="min-w-full border border-th-border rounded">
								{children}
							</table>
						</div>
					),
					thead: ({ children }) => (
						<thead className="bg-th-surface">{children}</thead>
					),
					th: ({ children }) => (
						<th className="border border-th-border px-3 py-2 text-left font-semibold">
							{children}
						</th>
					),
					td: ({ children }) => (
						<td className="border border-th-border px-3 py-2">{children}</td>
					),
					img: ({ src, alt }) => (
						<img
							src={resolveImageSrc(
								typeof src === "string" ? src : "",
								filesApiBase,
								filePath,
								sessionWorkingDir,
							)}
							alt={alt || "Image"}
							className="max-w-full h-auto rounded my-3"
							loading="lazy"
						/>
					),
					input: ({ type, checked, disabled }) => {
						if (type === "checkbox") {
							return (
								<input
									type="checkbox"
									checked={checked}
									disabled={disabled}
									className="mr-2 accent-blue-500"
									readOnly
								/>
							);
						}
						return null;
					},
				}}
			>
				{content}
			</ReactMarkdown>
		),
		[content, filePath, sessionWorkingDir, filesApiBase],
	);

	return (
		<div className="relative flex flex-col h-full bg-th-bg text-th-text">
			{truncated && (
				<div className="px-3 py-1.5 bg-yellow-900/50 text-yellow-300 text-xs border-b border-yellow-800">
					{t("files.fileTooLarge")}
				</div>
			)}

			<div
				ref={containerRef}
				className="flex-1 overflow-auto touch-pan-y p-4 markdown-content select-text"
				style={{
					fontSize: `${fontSize}px`,
					WebkitUserSelect: "text",
					userSelect: "text",
				}}
			>
				{renderedMarkdown}
			</div>

		</div>
	);
}
