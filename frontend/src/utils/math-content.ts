/**
 * Finds the math in a message and rewrites the delimiters remark-math does not
 * know about.
 *
 * remark-math reads `$...$` and `$$...$$` only, but the agents write LaTeX's
 * own `\(...\)` and `\[...\]` about as often, so those are rewritten to the
 * dollar forms before parsing.
 *
 * The rewrite has to happen on the source string - remark-math is a parser
 * extension, so a plugin running on the tree afterwards is already too late -
 * which means code has to be stepped over by hand here. Inside a fence, `\[`
 * is an array subscript and `$` is a shell variable, and neither is math.
 */

/** Fenced blocks and inline code spans, in the order they appear. */
const CODE = /(^|\n)([ \t]*)(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n[ \t]*\3[^\n]*(?=\n|$)|$)|(`+)[\s\S]*?\4/g;

const DISPLAY = /\\\[([\s\S]+?)\\\]/g;
const INLINE = /\\\(([\s\S]+?)\\\)/g;

/**
 * A line that is nothing but `$$...$$`.
 *
 * remark-math only reads that as display math when the fences are on lines of
 * their own; written on one line it is inline math that happens to sit in its
 * own paragraph, which renders at text size with cramped fractions. The agents
 * write the one-line form far more often, so it is opened out here.
 */
const ONE_LINE_DISPLAY = /^([ \t]*)\$\$[ \t]*(\S[^\n]*?)[ \t]*\$\$[ \t]*$/gm;

/** `$$...$$` or `$...$` with something between the delimiters. */
const DOLLAR = /\$\$[\s\S]+?\$\$|\$[^\s$][^$]*\$/;

function rewrite(text: string): string {
	return text
		.replace(DISPLAY, (_, body) => `$$${body}$$`)
		.replace(INLINE, (_, body) => `$${body}$`)
		.replace(
			ONE_LINE_DISPLAY,
			// The indent is carried onto all three lines: an unindented line would
			// end the list item the formula belongs to.
			(_, indent, body) => `${indent}$$\n${indent}${body}\n${indent}$$`,
		);
}

export interface PreparedMath {
	/** The source to render, with every delimiter in a form remark-math reads. */
	source: string;
	/** Whether any math survived the code-stepping, i.e. whether KaTeX is worth loading. */
	hasMath: boolean;
}

export function prepareMath(markdown: string): PreparedMath {
	let out = "";
	let hasMath = false;
	let last = 0;

	const consume = (text: string) => {
		const rewritten = rewrite(text);
		if (!hasMath && DOLLAR.test(rewritten)) hasMath = true;
		out += rewritten;
	};

	CODE.lastIndex = 0;
	let match = CODE.exec(markdown);
	while (match) {
		consume(markdown.slice(last, match.index));
		out += match[0];
		last = match.index + match[0].length;
		match = CODE.exec(markdown);
	}
	consume(markdown.slice(last));

	return { source: out, hasMath };
}
