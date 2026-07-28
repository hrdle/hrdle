import { describe, expect, test } from "bun:test";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import { IDENTITY } from "../../../shared/identity";

/**
 * The hook setup prompt is handed to an agent, which then edits the user's
 * settings file from it. So the config it carries has to be the config this app
 * actually looks for: a stale example (#538 left one asking for PreToolUse and
 * UserPromptSubmit, dropped in #390) is a wrong edit made on our instruction.
 */
const PROMPTS = [
	["ja", ja.onboarding.hookSetupPrompt],
	["en", en.onboarding.hookSetupPrompt],
] as const;

const COMMAND = `/home/me/bin/${IDENTITY.binaryName} notify`;

/**
 * Stands in for i18next, which fills `{{product}}` and `{{bin}}` from
 * `defaultVariables` without any call site passing them. The assertion below
 * that nothing `{{`-shaped survives is what makes this worth keeping in step:
 * a placeholder the real renderer knows about but this one does not would fail
 * here, and a placeholder neither knows about would reach the agent verbatim.
 */
function render(prompt: string): string {
	return prompt
		.replaceAll("{{command}}", COMMAND)
		.replaceAll("{{product}}", IDENTITY.productName)
		.replaceAll("{{bin}}", IDENTITY.binaryName);
}

/** The one `{"hooks":...}` object the prompt embeds as its example. */
function exampleConfig(prompt: string): {
	hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
} {
	const start = prompt.indexOf('{"hooks"');
	expect(start).toBeGreaterThanOrEqual(0);
	const end = prompt.indexOf("\n", start);
	return JSON.parse(prompt.slice(start, end === -1 ? undefined : end));
}

describe("hook setup prompt", () => {
	for (const [locale, prompt] of PROMPTS) {
		test(`${locale}: every command slot takes the resolved path`, () => {
			const rendered = render(prompt);
			expect(rendered).not.toContain("{{");
			// A bare `cchub notify` left anywhere would be copied verbatim by the
			// agent and die in the hook's non-interactive shell (#538).
			expect(rendered).not.toMatch(/(?:^|[^/\w])cchub notify/);
		});

		test(`${locale}: the example asks for exactly the two hooks we read`, () => {
			const { hooks } = exampleConfig(render(prompt));
			expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "Stop"]);
			expect(hooks.Stop[0].hooks[0].command).toBe(COMMAND);
			expect(hooks.PostToolUse[0].matcher).toBe("AskUserQuestion");
			expect(hooks.PostToolUse[0].hooks[0].command).toBe(COMMAND);
		});
	}
});
