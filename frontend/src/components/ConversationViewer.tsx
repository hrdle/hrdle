/** biome-ignore-all lint/correctness/useExhaustiveDependencies: depends on refs and setters that React guarantees stable; adding them would cause unintended re-runs */
/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: tap-to-zoom images and the lightbox backdrop; keyboard users close it with Escape */
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	Bot,
	Brain,
	Check,
	ChevronLeft,
	ChevronRight,
	Circle,
	CircleDot,
	Copy,
	FileText,
	Globe,
	ListTodo,
	Pencil,
	Search,
	Terminal,
	TriangleAlert,
	Wrench,
} from "lucide-react";
import {
	lazy,
	memo,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
	ConversationMessage,
	ToolResultInfo,
	ToolUseInfo,
} from "../../../shared/types";
import { prepareMath } from "../utils/math-content";
import { TMP_PATHS } from "../../../shared/identity";
import { agentBadge } from "../utils/agentDisplay";
import { storageKey } from "../utils/app-storage";
import {
	highlightToHtml,
	languageForOutput,
	languageFromClassName,
} from "../utils/codeHighlight";
import { getToolSummary } from "../utils/toolSummary";

const API_BASE = import.meta.env.VITE_API_URL || "";

// Conversation font size (shared across all sessions)
/**
 * Space kept under the last message.
 *
 * Without it the transcript ends flush against the bottom edge, where a phone
 * puts its home indicator and the app puts its session bar: the last line was
 * there, and unreachable, because there was nothing left to scroll.
 *
 * It covers a second thing, measured on the way in. The virtualizer's
 * `getTotalSize()` runs a steady ~45px short of what the rows actually render
 * to, so the tail of the final message hung below the sized container and was
 * clipped. This space absorbs that too.
 */
const CV_BOTTOM_SPACE = 128;

const CV_FONT_SIZE_KEY = storageKey("conversation-font-size");
const CV_DEFAULT_FONT_SIZE = 15;
const CV_MIN_FONT_SIZE = 11;
const CV_MAX_FONT_SIZE = 24;

function loadCvFontSize(): number {
	try {
		const saved = localStorage.getItem(CV_FONT_SIZE_KEY);
		if (saved) {
			const n = parseInt(saved, 10);
			if (!Number.isNaN(n) && n >= CV_MIN_FONT_SIZE && n <= CV_MAX_FONT_SIZE)
				return n;
		}
	} catch {
		// ignore
	}
	return CV_DEFAULT_FONT_SIZE;
}

function saveCvFontSize(n: number) {
	try {
		localStorage.setItem(CV_FONT_SIZE_KEY, String(n));
	} catch {
		// ignore
	}
}

function getPinchDistance(touches: TouchList): number {
	const dx = touches[0].clientX - touches[1].clientX;
	const dy = touches[0].clientY - touches[1].clientY;
	return Math.sqrt(dx * dx + dy * dy);
}

// Convert [Image: source: <imagesDir>/xxx.png] into an actual image.
//
// The directory is identity's — spelled out, it stops matching the
// moment the name changes and every screenshot in the conversation degrades
// into its own raw path. Transcripts written under the old name keep the old
// path forever, but the files they point at live in the previous install's
// /tmp and this server does not serve them, so matching those too would
// trade raw text for a broken image.
const IMAGE_REF_PATTERN = new RegExp(
	`\\[Image: source: ${TMP_PATHS.imagesDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/([^\\]]+)\\]`,
	"g",
);

function processImageReferences(content: string): string {
	return content.replace(
		IMAGE_REF_PATTERN,
		(_, filename) => `![Screenshot](${API_BASE}/api/images/${filename})`,
	);
}

// Check if a message is a system-generated summary (context continuation)
function isSystemSummary(content: string): boolean {
	return content.startsWith(
		"This session is being continued from a previous conversation that ran out of context",
	);
}

function openLightbox(src: string) {
	window.dispatchEvent(
		new CustomEvent("hrdle-image-zoom", { detail: { src } }),
	);
}

// =============================================================================
// Markdown
// =============================================================================

/**
 * Code block with a copy button.
 *
 * The text is read back off the rendered node rather than re-derived from the
 * markdown AST: react-markdown hands `pre` its children already parsed, and
 * innerText is what the reader actually sees.
 */
function CodeBlock({ children }: { children?: React.ReactNode }) {
	const preRef = useRef<HTMLPreElement>(null);
	const [copied, setCopied] = useState(false);

	const copy = useCallback(() => {
		const text = preRef.current?.innerText ?? "";
		if (!text) return;
		navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => {
				// clipboard unavailable (insecure context) — nothing useful to say
			});
	}, []);

	return (
		<div className="group relative my-3">
			<pre
				ref={preRef}
				className="cv-code overflow-x-auto rounded-xl border border-cv-border bg-cv-surface px-3.5 py-3 font-mono text-[0.85em] leading-relaxed text-cv-text-secondary"
			>
				{children}
			</pre>
			<button
				type="button"
				onClick={copy}
				aria-label="Copy code"
				className="absolute right-2 top-2 rounded-md border border-cv-border bg-cv-bg/80 p-1.5 text-cv-text-muted opacity-0 transition-opacity hover:text-cv-text focus:opacity-100 group-hover:opacity-100"
			>
				{copied ? (
					<Check className="h-3.5 w-3.5" />
				) : (
					<Copy className="h-3.5 w-3.5" />
				)}
			</button>
		</div>
	);
}

/**
 * A fenced block or a tool's output, coloured when we know the language.
 *
 * Falls back to a text node whenever `highlightToHtml` declines — the HTML
 * path is only ever fed output highlight.js escaped itself.
 */
function HighlightedCode({
	code,
	language,
}: {
	code: string;
	language: string | null;
}) {
	const html = useMemo(() => highlightToHtml(code, language), [code, language]);
	if (html === null) return <code>{code}</code>;
	return (
		// biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output, which escapes its input
		<code dangerouslySetInnerHTML={{ __html: html }} />
	);
}

const markdownComponents = {
	pre: ({ children }: { children?: React.ReactNode }) => (
		<CodeBlock>{children}</CodeBlock>
	),
	code: ({
		children,
		className,
	}: {
		children?: React.ReactNode;
		className?: string;
	}) => {
		const isBlock = className?.includes("language-");
		if (!isBlock) {
			return (
				<code className="rounded bg-cv-surface px-1.5 py-0.5 font-mono text-[0.85em] text-cv-text">
					{children}
				</code>
			);
		}
		return (
			<HighlightedCode
				code={String(children).replace(/\n$/, "")}
				language={languageFromClassName(className)}
			/>
		);
	},
	p: ({ children }: { children?: React.ReactNode }) => (
		<p className="my-3 leading-[1.7]">{children}</p>
	),
	ul: ({ children }: { children?: React.ReactNode }) => (
		<ul className="my-3 list-disc space-y-1 pl-5 leading-[1.7]">{children}</ul>
	),
	ol: ({ children }: { children?: React.ReactNode }) => (
		<ol className="my-3 list-decimal space-y-1 pl-5 leading-[1.7]">
			{children}
		</ol>
	),
	li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
	h1: ({ children }: { children?: React.ReactNode }) => (
		<h1 className="mb-2 mt-5 text-[1.3em] font-semibold text-cv-text">
			{children}
		</h1>
	),
	h2: ({ children }: { children?: React.ReactNode }) => (
		<h2 className="mb-2 mt-5 text-[1.15em] font-semibold text-cv-text">
			{children}
		</h2>
	),
	h3: ({ children }: { children?: React.ReactNode }) => (
		<h3 className="mb-1.5 mt-4 text-[1.05em] font-semibold text-cv-text">
			{children}
		</h3>
	),
	strong: ({ children }: { children?: React.ReactNode }) => (
		<strong className="font-semibold text-cv-text">{children}</strong>
	),
	em: ({ children }: { children?: React.ReactNode }) => (
		<em className="italic">{children}</em>
	),
	hr: () => <hr className="my-5 border-cv-border" />,
	a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
		<a
			href={href}
			className="text-cv-accent underline underline-offset-2"
			target="_blank"
			rel="noopener noreferrer"
		>
			{children}
		</a>
	),
	blockquote: ({ children }: { children?: React.ReactNode }) => (
		<blockquote className="my-3 border-l-2 border-cv-border pl-3 text-cv-text-secondary">
			{children}
		</blockquote>
	),
	table: ({ children }: { children?: React.ReactNode }) => (
		<div className="my-3 overflow-x-auto rounded-xl border border-cv-border">
			<table className="min-w-full text-[0.9em]">{children}</table>
		</div>
	),
	th: ({ children }: { children?: React.ReactNode }) => (
		<th className="border-b border-cv-border bg-cv-surface px-3 py-2 text-left font-medium">
			{children}
		</th>
	),
	td: ({ children }: { children?: React.ReactNode }) => (
		<td className="border-b border-cv-border px-3 py-2 align-top">
			{children}
		</td>
	),
	img: ({ src, alt }: { src?: string; alt?: string }) => (
		<img
			src={src}
			alt={alt || "Screenshot"}
			onClick={(e) => {
				if (!src) return;
				e.preventDefault();
				e.stopPropagation();
				openLightbox(src);
			}}
			onTouchEnd={(e) => {
				if (!src) return;
				e.preventDefault();
				e.stopPropagation();
				openLightbox(src);
			}}
			className="my-3 h-auto max-w-full cursor-zoom-in rounded-xl border border-cv-border"
			loading="lazy"
			draggable={false}
		/>
	),
};

const MathMarkdown = lazy(() => import("./MathMarkdown"));

function Markdown({ content }: { content: string }) {
	const { source, hasMath } = useMemo(
		() => prepareMath(processImageReferences(content)),
		[content],
	);

	// Also the fallback: until the chunk is here the message reads as the agent
	// typed it, which beats a blank where a paragraph was.
	const plain = (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
			{source}
		</ReactMarkdown>
	);

	return (
		<div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
			{hasMath ? (
				<Suspense fallback={plain}>
					<MathMarkdown content={source} components={markdownComponents} />
				</Suspense>
			) : (
				plain
			)}
		</div>
	);
}

// =============================================================================
// Tool calls
// =============================================================================

/** Tool name to icon. Names differ per agent, so match on substrings. */
function toolIcon(name: string) {
	const n = name.toLowerCase();
	if (n.includes("bash") || n.includes("shell") || n.includes("exec"))
		return Terminal;
	if (n.includes("todo") || n.includes("plan")) return ListTodo;
	if (n.includes("write") || n.includes("edit") || n.includes("patch"))
		return Pencil;
	if (n.includes("read") || n.includes("view") || n.includes("cat"))
		return FileText;
	if (n.includes("grep") || n.includes("glob") || n.includes("search"))
		return Search;
	if (n.includes("web") || n.includes("fetch") || n.includes("browser"))
		return Globe;
	if (n.includes("task") || n.includes("agent")) return Bot;
	return Wrench;
}

// Todo/plan tool inputs (Claude TodoWrite, Kimi TodoList, Codex update_plan)
// render as a graphical checklist instead of raw JSON.
interface TodoDisplayItem {
	text: string;
	status: "done" | "in_progress" | "pending";
}

function parseTodoInput(
	name: string,
	input: Record<string, unknown>,
): TodoDisplayItem[] | null {
	// `todos` is accepted by shape alone; a `plan` array only for Codex's
	// update_plan (Claude's ExitPlanMode has a string `plan`, filtered by
	// Array.isArray, but other tools may legitimately carry a plan array).
	const list = Array.isArray(input.todos)
		? input.todos
		: name === "update_plan" && Array.isArray(input.plan)
			? input.plan
			: null;
	if (!list || list.length === 0) return null;
	const items: TodoDisplayItem[] = [];
	for (const raw of list) {
		if (typeof raw !== "object" || raw === null) return null;
		const o = raw as Record<string, unknown>;
		const text = [o.content, o.title, o.step].find(
			(v): v is string => typeof v === "string" && v.length > 0,
		);
		if (!text) return null;
		const s = typeof o.status === "string" ? o.status : "";
		items.push({
			text,
			status:
				s === "completed" || s === "done"
					? "done"
					: s === "in_progress"
						? "in_progress"
						: "pending",
		});
	}
	return items;
}

function TodoChecklist({ items }: { items: TodoDisplayItem[] }) {
	return (
		<ul className="space-y-1">
			{items.map((item, idx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: render-only, order-stable
				<li key={idx} className="flex items-start gap-2">
					{item.status === "done" ? (
						<Check className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-500" />
					) : item.status === "in_progress" ? (
						<CircleDot className="mt-px h-3.5 w-3.5 shrink-0 text-cv-accent" />
					) : (
						<Circle className="mt-px h-3.5 w-3.5 shrink-0 text-cv-text-muted" />
					)}
					<span
						className={
							item.status === "done"
								? "text-cv-text-muted line-through"
								: item.status === "in_progress"
									? "text-cv-text"
									: "text-cv-text-secondary"
						}
					>
						{item.text}
					</span>
				</li>
			))}
		</ul>
	);
}

/** Long tool output: show a head, expand on demand. */
function ExpandableText({
	text,
	preview,
	language,
}: {
	text: string;
	preview: string;
	language: string | null;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);

	return (
		<>
			<HighlightedCode code={expanded ? text : preview} language={language} />
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="ml-2 text-cv-accent hover:underline"
			>
				{expanded ? t("conversation.collapse") : t("conversation.showAll")}
			</button>
		</>
	);
}

function ToolResultBody({
	result,
	filePath,
}: {
	result: ToolResultInfo;
	/** Path the call named, when it named one. A result never says what it is,
	 *  so the file it came from is the only clue its output has. */
	filePath: string | undefined;
}) {
	const { t } = useTranslation();
	const maxPreview = 500;
	const isLong = result.output.length > maxPreview;
	const preview = isLong
		? `${result.output.substring(0, maxPreview)}...`
		: result.output;
	const hasImages = !!result.images && result.images.length > 0;
	const hasOutput = result.output.length > 0;
	// An error is a message, not a listing: colouring it as source would only
	// argue with the red that says it failed.
	const outputLanguage = result.isError
		? null
		: languageForOutput(filePath, result.output);

	return (
		<div className="space-y-2">
			{hasOutput && (
				<pre
					className={`cv-code whitespace-pre-wrap break-all font-mono text-[length:var(--cv-fs-meta,12px)] ${
						result.isError ? "text-red-400" : "text-cv-text-secondary"
					}`}
				>
					{isLong ? (
						<ExpandableText
							text={result.output}
							preview={preview}
							language={outputLanguage}
						/>
					) : (
						<HighlightedCode code={result.output} language={outputLanguage} />
					)}
				</pre>
			)}
			{hasImages && (
				<div className="flex flex-wrap gap-2">
					{result.images?.map((img, i) => {
						const src = `data:${img.mediaType};base64,${img.data}`;
						return (
							<img
								// biome-ignore lint/suspicious/noArrayIndexKey: images array is render-only, order-stable
								key={i}
								src={src}
								alt="Tool result"
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									openLightbox(src);
								}}
								onTouchEnd={(e) => {
									e.preventDefault();
									e.stopPropagation();
									openLightbox(src);
								}}
								className="h-auto max-w-[280px] cursor-zoom-in rounded-lg border border-cv-border"
								loading="lazy"
								draggable={false}
							/>
						);
					})}
				</div>
			)}
			{!hasOutput && !hasImages && (
				<p className="font-mono text-[length:var(--cv-fs-meta,12px)] text-cv-text-muted">
					{t("conversation.noOutput")}
				</p>
			)}
		</div>
	);
}

/**
 * A tool call and its result as one card.
 *
 * The transcript stores them apart — the call on the assistant turn, the result
 * on the user turn that follows — which is how the previous layout ended up
 * showing a "System" speaker saying the output of something two screens up.
 * Pairing them by `toolUseId` puts the answer where the question was asked.
 */
function ToolCard({
	call,
	result,
}: {
	call?: ToolUseInfo;
	result?: ToolResultInfo;
}) {
	const { t } = useTranslation();
	const todos = call ? parseTodoInput(call.name, call.input) : null;
	const isError = !!result?.isError;
	const [open, setOpen] = useState(!!todos || isError);

	const name = call?.name ?? result?.toolName ?? t("conversation.toolResult");
	const summary = call ? getToolSummary(call.input) : "";
	// Read/Write/Edit name a file; its extension is what tells the output what
	// language it is looking at.
	const calledPath = call
		? ((call.input.file_path ??
				call.input.filePath ??
				call.input.path ??
				call.input.notebook_path) as string | undefined)
		: undefined;
	const Icon = isError ? TriangleAlert : toolIcon(name);
	const done = todos ? todos.filter((i) => i.status === "done").length : 0;

	return (
		<div className="my-2 overflow-hidden rounded-xl border border-cv-border">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex w-full items-center gap-2 bg-cv-surface px-3 py-2 text-left text-[length:var(--cv-fs-meta,12px)] transition-colors hover:bg-cv-surface-hover"
			>
				<ChevronRight
					className={`h-3 w-3 shrink-0 text-cv-text-muted transition-transform ${open ? "rotate-90" : ""}`}
				/>
				<Icon
					className={`h-3.5 w-3.5 shrink-0 ${isError ? "text-red-400" : "text-cv-text-muted"}`}
				/>
				<span
					className={`shrink-0 font-medium ${isError ? "text-red-400" : "text-cv-text-secondary"}`}
				>
					{name}
					{todos ? ` (${done}/${todos.length})` : ""}
				</span>
				{summary && (
					<span className="truncate font-mono text-cv-text-muted">
						{summary}
					</span>
				)}
			</button>
			{open && (
				<div className="space-y-3 border-t border-cv-border px-3 py-2.5">
					{todos && <TodoChecklist items={todos} />}
					{call && !todos && (
						<pre className="cv-code overflow-x-auto whitespace-pre-wrap break-all font-mono text-[length:var(--cv-fs-meta,12px)] text-cv-text-secondary">
							<HighlightedCode
								code={JSON.stringify(call.input, null, 2)}
								language="json"
							/>
						</pre>
					)}
					{result && (
						<div className={call ? "border-t border-cv-border pt-2.5" : ""}>
							<ToolResultBody result={result} filePath={calledPath} />
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function ThinkingBlock({ text }: { text: string }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);

	return (
		<div className="my-2">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1.5 text-[length:var(--cv-fs-meta,12px)] text-cv-text-muted hover:text-cv-text-secondary"
			>
				<Brain className="h-3.5 w-3.5 shrink-0" />
				<span>{t("conversation.thinking")}</span>
				<ChevronRight
					className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
				/>
			</button>
			{open && (
				<div className="mt-1.5 border-l-2 border-cv-border pl-3 text-cv-text-secondary italic">
					<Markdown content={text} />
				</div>
			)}
		</div>
	);
}

/** Context-continuation summaries: kept, but folded away by default. */
function SummaryCard({ text }: { text: string }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);

	return (
		<div className="my-2 overflow-hidden rounded-xl border border-cv-border">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex w-full items-center gap-2 bg-cv-surface px-3 py-2 text-left text-[length:var(--cv-fs-meta,12px)] text-cv-text-muted transition-colors hover:bg-cv-surface-hover"
			>
				<ChevronRight
					className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
				/>
				<span>{t("conversation.systemSummary")}</span>
			</button>
			{open && (
				<div className="border-t border-cv-border px-3 py-2.5 text-cv-text-secondary">
					<Markdown content={text} />
				</div>
			)}
		</div>
	);
}

// =============================================================================
// Rows
// =============================================================================

/**
 * A message plus the tool results that belong to the calls it made.
 *
 * Messages that carry nothing but results of calls shown elsewhere never become
 * a row at all — they are the previous layout's "System" turns.
 */
interface DisplayRow {
	msg: ConversationMessage;
	/** Result per tool call in `msg.toolUse`, by index. */
	results: (ToolResultInfo | undefined)[];
	/** Results whose call is nowhere in this conversation (truncated history). */
	orphanResults: ToolResultInfo[];
	/** First row of a turn. A burst of tool calls is one speaker, not twelve. */
	showSpeaker: boolean;
}

function buildRows(messages: ConversationMessage[]): DisplayRow[] {
	const resultByCallId = new Map<string, ToolResultInfo>();
	const callIds = new Set<string>();
	for (const msg of messages) {
		for (const call of msg.toolUse ?? []) callIds.add(call.id);
		for (const result of msg.toolResult ?? []) {
			if (!resultByCallId.has(result.toolUseId))
				resultByCallId.set(result.toolUseId, result);
		}
	}

	const rows: DisplayRow[] = [];
	let prevRole: ConversationMessage["role"] | null = null;
	for (const msg of messages) {
		const calls = msg.toolUse ?? [];
		const orphanResults = (msg.toolResult ?? []).filter(
			(r) => !callIds.has(r.toolUseId),
		);
		const hasBody = !!msg.content || !!msg.thinking || calls.length > 0;
		if (!hasBody && orphanResults.length === 0) continue;
		rows.push({
			msg,
			results: calls.map((c) => resultByCallId.get(c.id)),
			orphanResults,
			showSpeaker: msg.role !== prevRole,
		});
		prevRole = msg.role;
	}
	return rows;
}

const MessageRow = memo(function MessageRow({
	row,
	agent,
}: {
	row: DisplayRow;
	agent?: string;
}) {
	const { msg, results, orphanResults } = row;
	const calls = msg.toolUse ?? [];

	const orphans = orphanResults.map((result) => (
		<ToolCard key={result.toolUseId} result={result} />
	));

	if (msg.role === "user") {
		if (msg.content && isSystemSummary(msg.content)) {
			return <SummaryCard text={msg.content} />;
		}
		// The user's own turn: a bubble on the right, the one place in the view
		// where text is not the full column width.
		return (
			<div className="flex flex-col items-end gap-1">
				{msg.content && (
					<div className="max-w-[85%] rounded-2xl bg-cv-bubble px-4 py-2.5 text-cv-text">
						<Markdown content={msg.content} />
					</div>
				)}
				{orphans.length > 0 && <div className="w-full">{orphans}</div>}
			</div>
		);
	}

	const badge = agentBadge(agent);
	return (
		<div>
			{row.showSpeaker && (
				<div className="mb-1 flex items-center gap-1.5">
					<span className={`h-1.5 w-1.5 rounded-full ${badge.barClassName}`} />
					<span className="text-[length:var(--cv-fs-meta,12px)] font-medium text-cv-text-muted">
						{badge.label}
					</span>
				</div>
			)}
			{msg.thinking && <ThinkingBlock text={msg.thinking} />}
			{msg.content && (
				<div className="text-cv-text">
					<Markdown content={msg.content} />
				</div>
			)}
			{calls.map((call, idx) => (
				<ToolCard key={call.id} call={call} result={results[idx]} />
			))}
			{orphans}
		</div>
	);
});

// =============================================================================
// Viewer
// =============================================================================

interface ConversationViewerProps {
	title: string;
	subtitle?: string;
	messages: ConversationMessage[];
	isLoading: boolean;
	onClose: () => void;
	onResume?: () => void;
	isResuming?: boolean;
	scrollToBottom?: boolean;
	isActive?: boolean; // Whether the session is actively running
	onRefresh?: () => void; // Callback to refresh conversation
	inline?: boolean; // If true, render inline instead of fullscreen modal
	/** Agent that produced these messages. Switches the assistant label. */
	agent?: string;
}

export function ConversationViewer({
	title,
	subtitle,
	messages,
	isLoading,
	onClose,
	onResume,
	isResuming,
	scrollToBottom = false,
	isActive = false,
	onRefresh,
	inline = false,
	agent,
}: ConversationViewerProps) {
	const { t } = useTranslation();
	const parentRef = useRef<HTMLDivElement>(null);
	const [prevRowCount, setPrevRowCount] = useState(0);
	const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

	const rows = useMemo(() => buildRows(messages), [messages]);

	// Inline images (rendered by markdownComponents) dispatch this event when
	// tapped. Listening at the component level (rather than event delegation
	// on the scroll container) sidesteps cases where parent handlers swallow
	// the click on touch devices.
	useEffect(() => {
		const onZoom = (e: Event) => {
			const detail = (e as CustomEvent<{ src: string }>).detail;
			if (detail?.src) setLightboxSrc(detail.src);
		};
		window.addEventListener("hrdle-image-zoom", onZoom);
		return () => window.removeEventListener("hrdle-image-zoom", onZoom);
	}, []);

	// Esc to close lightbox
	useEffect(() => {
		if (!lightboxSrc) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setLightboxSrc(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [lightboxSrc]);

	const [fontSize, setFontSize] = useState<number>(loadCvFontSize);
	const [showFontSizeIndicator, setShowFontSizeIndicator] = useState(false);
	const fontSizeIndicatorTimerRef = useRef<number | null>(null);

	const changeFontSize = useCallback((delta: number) => {
		setFontSize((prev) => {
			const next = Math.max(
				CV_MIN_FONT_SIZE,
				Math.min(CV_MAX_FONT_SIZE, prev + delta),
			);
			if (next !== prev) saveCvFontSize(next);
			return next;
		});
	}, []);
	const resetFontSize = useCallback(() => {
		setFontSize(CV_DEFAULT_FONT_SIZE);
		saveCvFontSize(CV_DEFAULT_FONT_SIZE);
	}, []);

	// Briefly show the size indicator after any change
	useEffect(() => {
		setShowFontSizeIndicator(true);
		if (fontSizeIndicatorTimerRef.current)
			clearTimeout(fontSizeIndicatorTimerRef.current);
		fontSizeIndicatorTimerRef.current = window.setTimeout(
			() => setShowFontSizeIndicator(false),
			1200,
		);
		return () => {
			if (fontSizeIndicatorTimerRef.current)
				clearTimeout(fontSizeIndicatorTimerRef.current);
		};
	}, [fontSize]);

	// Pinch-zoom on the message scroll container to change font size
	useEffect(() => {
		const el = parentRef.current;
		if (!el) return;
		let pinch: { d: number; size: number } | null = null;
		const onStart = (e: TouchEvent) => {
			if (e.touches.length === 2) {
				e.preventDefault();
				pinch = { d: getPinchDistance(e.touches), size: fontSize };
			}
		};
		const onMove = (e: TouchEvent) => {
			if (e.touches.length === 2 && pinch) {
				e.preventDefault();
				const scale = getPinchDistance(e.touches) / pinch.d;
				const next = Math.round(pinch.size * scale);
				const clamped = Math.max(
					CV_MIN_FONT_SIZE,
					Math.min(CV_MAX_FONT_SIZE, next),
				);
				setFontSize((prev) => (prev === clamped ? prev : clamped));
			}
		};
		const onEnd = (e: TouchEvent) => {
			if (e.touches.length < 2 && pinch) {
				pinch = null;
				// Persist the final size after pinch ends
				setFontSize((prev) => {
					saveCvFontSize(prev);
					return prev;
				});
			}
		};
		el.addEventListener("touchstart", onStart, { passive: false });
		el.addEventListener("touchmove", onMove, { passive: false });
		el.addEventListener("touchend", onEnd);
		el.addEventListener("touchcancel", onEnd);
		return () => {
			el.removeEventListener("touchstart", onStart);
			el.removeEventListener("touchmove", onMove);
			el.removeEventListener("touchend", onEnd);
			el.removeEventListener("touchcancel", onEnd);
		};
	}, [fontSize]);

	// Whether the reader is at the live edge. Streaming output only follows the
	// scroll when they are — otherwise reading older output yanks them back.
	const atBottomRef = useRef(true);
	useEffect(() => {
		const el = parentRef.current;
		if (!el) return;
		// The trailing space counts as "at the bottom". Auto-follow aligns the
		// last message to the viewport edge, which leaves the column's own
		// padding below it — `pt + pb` of unconsumed scroll — so a bare 24px
		// threshold would read that as "the reader scrolled away" and stop
		// following after the first message.
		const BOTTOM_THRESHOLD = CV_BOTTOM_SPACE + 48;
		const onScroll = () => {
			atBottomRef.current =
				el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: (index) => {
			// Better estimate based on content length to reduce scroll jank
			const row = rows[index];
			if (!row) return 120;
			const len = row.msg.content?.length || 0;
			const tools = (row.msg.toolUse?.length || 0) * 40;
			if (len < 100) return 72 + tools;
			if (len < 500) return 160 + tools;
			if (len < 2000) return 320 + tools;
			return 520 + tools;
		},
		overscan: 10,
	});

	const scrollToEnd = useCallback(() => {
		if (rows.length > 0) {
			virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
		}
	}, [virtualizer, rows.length]);

	useEffect(() => {
		if (scrollToBottom && rows.length > 0 && !isLoading) {
			if (rows.length > prevRowCount) {
				if (atBottomRef.current) {
					requestAnimationFrame(() => {
						scrollToEnd();
					});
				}
			}
			setPrevRowCount(rows.length);
		}
	}, [rows.length, isLoading, scrollToBottom, prevRowCount, scrollToEnd]);

	// Snap to bottom when the container becomes visible (e.g. unhidden after
	// mounting under display:none). Without this, scrollToEnd above runs while
	// the parent has 0 height and silently no-ops.
	const rowsLenRef = useRef(rows.length);
	rowsLenRef.current = rows.length;
	useEffect(() => {
		if (!scrollToBottom) return;
		const el = parentRef.current;
		if (!el) return;
		let prevHeight = el.clientHeight;
		const ro = new ResizeObserver(() => {
			const h = el.clientHeight;
			if (h > 0 && prevHeight === 0 && rowsLenRef.current > 0) {
				requestAnimationFrame(() => {
					virtualizer.scrollToIndex(rowsLenRef.current - 1, { align: "end" });
				});
			}
			prevHeight = h;
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [scrollToBottom, virtualizer]);

	// Auto-refresh when session is active (silently in background)
	useEffect(() => {
		if (!isActive || !onRefresh) return;
		const interval = setInterval(() => {
			onRefresh();
		}, 3000);
		return () => clearInterval(interval);
	}, [isActive, onRefresh]);

	const containerClass = inline
		? "h-full flex flex-col relative bg-cv-bg"
		: "fixed inset-0 z-50 flex flex-col bg-cv-bg";

	return (
		<div className={containerClass}>
			{/* Floating font-size controls (bottom-left) — only visible when the
          user is actively changing the size (via pinch / button) or hovering
          the bottom-left hot-zone on desktop. Tap the small "Aa" badge on
          touch devices to reveal. */}
			{inline && (
				<div className="group absolute bottom-2 left-2 z-30">
					<button
						type="button"
						onClick={() => {
							setShowFontSizeIndicator(true);
							if (fontSizeIndicatorTimerRef.current)
								clearTimeout(fontSizeIndicatorTimerRef.current);
							fontSizeIndicatorTimerRef.current = window.setTimeout(
								() => setShowFontSizeIndicator(false),
								4000,
							);
						}}
						className={`flex h-6 w-6 items-center justify-center rounded text-[10px] font-medium text-cv-text-muted transition-opacity hover:text-cv-text ${
							showFontSizeIndicator
								? "opacity-0"
								: "opacity-60 hover:opacity-100"
						}`}
						aria-label="Show font size controls"
						title="Font size"
					>
						Aa
					</button>
					<div
						className={`absolute bottom-0 left-0 flex items-center gap-1 transition-opacity duration-150 ${
							showFontSizeIndicator
								? "pointer-events-auto opacity-100"
								: "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
						}`}
					>
						<div className="flex items-center rounded-lg border border-cv-border bg-cv-surface">
							<button
								type="button"
								onClick={() => changeFontSize(-1)}
								className="flex h-7 w-7 items-center justify-center text-sm text-cv-text-secondary transition-colors hover:bg-cv-surface-hover hover:text-cv-text"
								aria-label="Decrease font size"
								title="Decrease font size"
							>
								−
							</button>
							<button
								type="button"
								onClick={resetFontSize}
								className="h-7 border-x border-cv-border px-1.5 text-[10px] text-cv-text-muted transition-colors hover:bg-cv-surface-hover hover:text-cv-text"
								aria-label="Reset font size"
								title="Reset font size"
							>
								A
							</button>
							<button
								type="button"
								onClick={() => changeFontSize(1)}
								className="flex h-7 w-7 items-center justify-center text-sm text-cv-text-secondary transition-colors hover:bg-cv-surface-hover hover:text-cv-text"
								aria-label="Increase font size"
								title="Increase font size"
							>
								＋
							</button>
						</div>
						<div className="rounded bg-cv-surface px-2 py-1 text-[11px] font-medium text-cv-text-secondary">
							{fontSize}px
						</div>
					</div>
				</div>
			)}

			{/* Messages */}
			<div
				ref={parentRef}
				className="relative flex-1 select-text overflow-y-auto overscroll-contain"
				style={{
					WebkitUserSelect: "text",
					userSelect: "text",
					WebkitTouchCallout: "default",
					fontSize: `${fontSize}px`,
					["--cv-fs-meta" as never]: `${Math.max(10, fontSize - 3)}px`,
				}}
			>
				<div
					className="mx-auto w-full max-w-[46rem] px-4 pt-5"
					style={{
						paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + ${CV_BOTTOM_SPACE}px)`,
					}}
				>
					{isLoading ? (
						<div className="py-10 text-center text-cv-text-muted">
							{t("common.loading")}
						</div>
					) : rows.length === 0 ? (
						<div className="py-10 text-center text-cv-text-muted">
							{t("conversation.noMessages")}
						</div>
					) : (
						<div
							style={{
								height: `${virtualizer.getTotalSize()}px`,
								width: "100%",
								position: "relative",
							}}
						>
							<div
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									transform: `translateY(${virtualizer.getVirtualItems()[0]?.start ?? 0}px)`,
								}}
							>
								{virtualizer.getVirtualItems().map((virtualRow) => (
									<div
										key={virtualRow.key}
										data-index={virtualRow.index}
										ref={virtualizer.measureElement}
									>
										<div
											className={
												rows[virtualRow.index]?.showSpeaker
													? "pb-1 pt-5"
													: "pb-1"
											}
										>
											<MessageRow row={rows[virtualRow.index]} agent={agent} />
										</div>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Footer - only show in modal mode */}
			{!inline && (
				<div className="flex shrink-0 items-center border-t border-cv-border bg-cv-bg px-3 py-2">
					<button
						type="button"
						onClick={onClose}
						className="p-1.5 text-cv-text-muted transition-colors hover:text-cv-text"
						aria-label="Close"
					>
						<ChevronLeft className="h-5 w-5" />
					</button>
					<div className="ml-2 min-w-0 flex-1">
						<h2 className="truncate text-[13px] font-medium text-cv-text">
							{title}
						</h2>
						{subtitle && (
							<p className="truncate text-[11px] text-cv-text-muted">
								{subtitle}
							</p>
						)}
					</div>
					{onResume && (
						<button
							type="button"
							onClick={onResume}
							disabled={isResuming}
							className="ml-2 shrink-0 rounded-lg bg-cv-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
						>
							{isResuming ? t("session.resuming") : t("session.resume")}
						</button>
					)}
				</div>
			)}

			{/* Image lightbox — tap an inline image to open at full size */}
			{lightboxSrc && (
				<div
					className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/90 p-4"
					onClick={() => setLightboxSrc(null)}
					onTouchEnd={() => setLightboxSrc(null)}
				>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							setLightboxSrc(null);
						}}
						className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"
						aria-label="Close"
					>
						<svg
							aria-hidden="true"
							className="h-5 w-5"
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
					</button>
					<img
						src={lightboxSrc}
						alt="Expanded"
						className="max-h-full max-w-full select-none object-contain"
						onClick={(e) => e.stopPropagation()}
						draggable={false}
					/>
				</div>
			)}
		</div>
	);
}
