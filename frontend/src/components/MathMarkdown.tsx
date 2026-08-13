import "katex/dist/katex.min.css";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/**
 * The markdown renderer for a message that actually contains math.
 *
 * Its own chunk on purpose: KaTeX and its stylesheet are about a third of what
 * the rest of the app weighs, the service worker precaches every chunk it is
 * told about, and this page is served to phones over a tailnet. A transcript
 * with no math must not pay for one that has some, so `ConversationViewer`
 * loads this only when `prepareMath` has found something.
 */
export default function MathMarkdown({
	content,
	components,
}: {
	content: string;
	components: Components;
}) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, remarkMath]}
			rehypePlugins={[rehypeKatex]}
			components={components}
		>
			{content}
		</ReactMarkdown>
	);
}
