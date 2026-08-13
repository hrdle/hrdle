import { describe, expect, it } from "bun:test";
import { prepareMath } from "./math-content";

describe("prepareMath", () => {
	it("reports no math for ordinary prose", () => {
		const { source, hasMath } = prepareMath("Just a sentence with no math in it.");
		expect(hasMath).toBe(false);
		expect(source).toBe("Just a sentence with no math in it.");
	});

	it("opens a one-line $$...$$ out so it renders as display math", () => {
		const { source, hasMath } = prepareMath("The drop is\n\n$$1 \\times 2 = 2$$\n");
		expect(source).toBe("The drop is\n\n$$\n1 \\times 2 = 2\n$$\n");
		expect(hasMath).toBe(true);
	});

	it("leaves display math that is already fenced on its own lines", () => {
		const md = "before\n\n$$\nx = 1\n$$\n\nafter";
		expect(prepareMath(md)).toEqual({ source: md, hasMath: true });
	});

	it("keeps the indent when opening a one-line $$...$$ inside a list", () => {
		const { source } = prepareMath("- item\n\n  $$x = 1$$\n");
		expect(source).toBe("- item\n\n  $$\n  x = 1\n  $$\n");
	});

	it("leaves $$...$$ alone when it shares the line with prose", () => {
		const { source } = prepareMath("so $$x = 1$$ holds");
		expect(source).toBe("so $$x = 1$$ holds");
	});

	it("finds inline math written with dollars", () => {
		expect(prepareMath("so $x = 1$ holds").hasMath).toBe(true);
	});

	it("rewrites LaTeX display delimiters", () => {
		const { source, hasMath } = prepareMath("before \\[a + b\\] after");
		expect(source).toBe("before $$a + b$$ after");
		expect(hasMath).toBe(true);
	});

	it("rewrites LaTeX inline delimiters", () => {
		const { source, hasMath } = prepareMath("energy is \\(E = mc^2\\) exactly");
		expect(source).toBe("energy is $E = mc^2$ exactly");
		expect(hasMath).toBe(true);
	});

	it("leaves fenced code alone", () => {
		const md = "```bash\necho \\[not math\\] $HOME $PATH\n```";
		expect(prepareMath(md)).toEqual({ source: md, hasMath: false });
	});

	it("leaves an indented fence alone", () => {
		const md = "- item\n\n  ```js\n  const a = arr\\[0\\];\n  ```\n";
		expect(prepareMath(md)).toEqual({ source: md, hasMath: false });
	});

	it("leaves inline code alone", () => {
		const md = "run `echo $HOME` and `arr\\[0\\]` first";
		expect(prepareMath(md)).toEqual({ source: md, hasMath: false });
	});

	it("still finds math around a code block", () => {
		const md = "```\n$PATH\n```\n\nand then \\(x\\)";
		const { source, hasMath } = prepareMath(md);
		expect(source).toBe("```\n$PATH\n```\n\nand then $x$");
		expect(hasMath).toBe(true);
	});

	it("does not treat an unterminated dollar as math", () => {
		expect(prepareMath("costs $5 per month").hasMath).toBe(false);
	});

	it("does not treat a dollar followed by a space as inline math", () => {
		expect(prepareMath("$ cd /tmp and then $ ls").hasMath).toBe(false);
	});

	it("keeps an unclosed fence from swallowing later math", () => {
		const md = "```\nunterminated";
		expect(prepareMath(md)).toEqual({ source: md, hasMath: false });
	});
});
