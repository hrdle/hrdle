import type { ReactNode } from "react";

/**
 * The dashboard's one box.
 *
 * Every widget used to draw its own: the panel wrapped each in
 * `bg-white/[0.03] rounded-lg p-4 border`, and then the widget drew a second
 * `p-3 bg-th-surface rounded-md` inside it — two borders and 28px of padding
 * around a chart 80px tall, in a panel narrow enough that the space was the
 * scarce thing. Titles had drifted too: some `text-sm font-medium text-th-text`
 * in a div, some `text-xs text-th-text-secondary` in an h3, for headings at the
 * same level of the same list.
 *
 * So widgets render content and this renders the box. A title passed as a
 * string gets the one heading style; pass a node when it needs a badge or a
 * status dot beside it.
 */
interface CardProps {
	title?: ReactNode;
	/** Right-aligned meta on the title row — a plan badge, a staleness note. */
	aside?: ReactNode;
	/**
	 * A muted line under the content, for what the panel cannot show and why.
	 * These were full cards of their own, which gave an apology the same weight
	 * as a chart.
	 */
	footnote?: ReactNode;
	className?: string;
	children: ReactNode;
}

export function Card({
	title,
	aside,
	footnote,
	className = "",
	children,
}: CardProps) {
	// A div, not a section: the three real sections are landmarks with headings,
	// and a dozen unnamed sections inside them only adds noise to a screen
	// reader's region list.
	return (
		<div
			className={`bg-white/[0.03] rounded-lg border border-white/[0.06] p-3.5 ${className}`}
		>
			{(title || aside) && (
				<div className="flex items-center justify-between gap-2 mb-2.5">
					{typeof title === "string" ? <CardTitle>{title}</CardTitle> : title}
					{aside}
				</div>
			)}
			{children}
			{footnote && (
				<p className="mt-3 pt-2.5 border-t border-white/[0.05] text-[10px] leading-relaxed text-th-text-muted">
					{footnote}
				</p>
			)}
		</div>
	);
}

/** The heading style, exported for titles that need extra elements beside them. */
export function CardTitle({ children }: { children: ReactNode }) {
	return (
		<h3 className="text-[13px] font-medium text-th-text truncate">{children}</h3>
	);
}

/** A row of stat tiles inside a card — the shape Grok/Kimi/OpenRouter share. */
export function StatTile({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="bg-white/[0.03] rounded-md px-2.5 py-2 border border-white/[0.06]">
			<div className="text-[11px] text-th-text-muted mb-0.5">{label}</div>
			{children}
		</div>
	);
}
