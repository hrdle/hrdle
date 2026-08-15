import {
	BarChart3,
	ExternalLink,
	FileText,
	Keyboard,
	List,
	MessageSquare,
	RefreshCw,
	SplitSquareHorizontal,
	SplitSquareVertical,
	Terminal as TerminalIcon,
	Unplug,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * The layouts an action can appear on.
 *
 * All three share `DesktopLayout` and differ by `variant`. Three names because
 * what a control should do is a question about the screen.
 */
export type LayoutVariant = "mobile" | "tablet" | "desktop";

export interface SessionAction {
	id: string;
	icon: LucideIcon;
	/** i18n key for the tooltip and the accessible name. */
	labelKey: string;
	/** Shown when the action is on and reads differently that way. */
	labelKeyActive?: string;
	availableOn: readonly LayoutVariant[];
	/** Onboarding spotlights target the DOM, so the attribute has to travel
	 *  with the action rather than with whichever bar used to carry it. */
	onboarding?: string;
	/** Not every control is neutral: the Claude app link and the remote-control
	 *  toggle have carried their own colour since before this table existed. */
	tone?: "violet" | "amber";
	/** Keeps the rule that separates the pane operations from the rest. */
	separatorBefore?: boolean;
}

const ALL_LAYOUTS = ["mobile", "tablet", "desktop"] as const;

/**
 * Every control in a session bar, in one place.
 *
 * Mobile and desktop/tablet used to be separate component trees, so each action
 * was wired by hand into each of them - and a new one reached whichever tree the
 * person adding it happened to be looking at. That is the source of "the phone
 * never got it": not carelessness, but a structure with no single place to put
 * the answer. The trees are one now; this table is still where the answer goes.
 *
 * `availableOn` records where each action is **today**, not where it ought to
 * be. Several of the gaps below look like omissions rather than decisions -
 * split is tablet-only, files and reload never reached the desktop bar, the
 * remote-control toggle is desktop-only - and closing them is a change to the
 * product that someone should choose, one at a time. Recording the current
 * shape first is what makes them visible at all.
 */
export const SESSION_ACTIONS: readonly SessionAction[] = [
	{
		id: "sessions",
		icon: List,
		labelKey: "action.sessions",
		availableOn: ["desktop"],
	},
	{
		id: "chat",
		icon: MessageSquare,
		labelKey: "action.chat",
		labelKeyActive: "action.terminal",
		availableOn: ["mobile"],
		onboarding: "conversation",
	},
	{
		id: "claude-app",
		icon: ExternalLink,
		labelKey: "session.openInClaudeApp",
		availableOn: ["mobile"],
		tone: "violet",
	},
	{
		id: "files",
		icon: FileText,
		labelKey: "action.files",
		availableOn: ["mobile", "tablet"],
		onboarding: "file-browser",
	},
	{
		id: "dashboard",
		icon: BarChart3,
		labelKey: "action.dashboard",
		availableOn: ALL_LAYOUTS,
	},
	{
		id: "split-h",
		icon: SplitSquareHorizontal,
		labelKey: "action.splitVertically",
		availableOn: ["tablet"],
		onboarding: "split-pane",
		separatorBefore: true,
	},
	{
		id: "split-v",
		icon: SplitSquareVertical,
		labelKey: "action.splitHorizontally",
		availableOn: ["tablet"],
	},
	{
		id: "reload",
		icon: RefreshCw,
		labelKey: "action.reload",
		availableOn: ["mobile", "tablet"],
		onboarding: "reload",
	},
	{
		id: "keyboard",
		icon: Keyboard,
		labelKey: "action.showKeyboard",
		labelKeyActive: "action.hideKeyboard",
		availableOn: ["tablet"],
		onboarding: "keyboard",
	},
	{
		id: "remote-control",
		icon: Unplug,
		labelKey: "action.remoteControlOff",
		labelKeyActive: "action.remoteControlOn",
		availableOn: ["desktop"],
		tone: "amber",
	},
] as const;

/** The chat toggle swaps its icon rather than its colour, so it needs the
 *  other one too. Kept beside the table it belongs to. */
export const CHAT_ACTIVE_ICON = TerminalIcon;

export function actionsFor(variant: LayoutVariant): SessionAction[] {
	return SESSION_ACTIONS.filter((a) => a.availableOn.includes(variant));
}

/** Stable hook for the responsive e2e, which asserts that every action its
 *  definition names for a layout is actually rendered there. */
export function actionTestId(id: string): string {
	return `action-${id}`;
}
