import {
	AGENT_PROVIDERS,
	type AgentProvider,
	isAgentProvider,
} from "../../../shared/types";

/**
 * Per-provider display styling. The single place to touch when adding an
 * agent's colors — labels come from the shared registry (`displayName`).
 * Tailwind needs literal class strings, so these can't be computed.
 */
interface AgentBadgeStyle {
	label: string;
	/** History/session badge chip. */
	badgeClassName: string;
	/** ConversationViewer speaker bar. */
	barClassName: string;
	/** ConversationViewer role label. */
	labelClassName: string;
}

const AGENT_BADGES: Record<AgentProvider, AgentBadgeStyle> = {
	claude: {
		label: AGENT_PROVIDERS.claude.displayName,
		badgeClassName: "text-violet-300 bg-violet-400/10 border-violet-400/20",
		barClassName: "bg-violet-400/70",
		labelClassName: "text-violet-300",
	},
	codex: {
		label: AGENT_PROVIDERS.codex.displayName,
		badgeClassName: "text-cyan-300 bg-cyan-400/10 border-cyan-400/20",
		barClassName: "bg-cyan-400/70",
		labelClassName: "text-cyan-300",
	},
	grok: {
		label: AGENT_PROVIDERS.grok.displayName,
		badgeClassName: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
		barClassName: "bg-emerald-400/70",
		labelClassName: "text-emerald-300",
	},
	kimi: {
		label: AGENT_PROVIDERS.kimi.displayName,
		badgeClassName: "text-amber-300 bg-amber-400/10 border-amber-400/20",
		barClassName: "bg-amber-400/70",
		labelClassName: "text-amber-300",
	},
	opencode: {
		label: AGENT_PROVIDERS.opencode.displayName,
		badgeClassName: "text-orange-300 bg-orange-400/10 border-orange-400/20",
		barClassName: "bg-orange-400/70",
		labelClassName: "text-orange-300",
	},
};

/** Badge style for a provider; unknown/undefined falls back to Claude. */
export function agentBadge(agent: string | undefined): AgentBadgeStyle {
	return AGENT_BADGES[agent && isAgentProvider(agent) ? agent : "claude"];
}
