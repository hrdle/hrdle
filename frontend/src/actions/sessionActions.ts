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
	Maximize2,
	Terminal as TerminalIcon,
	Unplug,
	X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * The layouts an action can appear on.
 *
 * All three share `DesktopLayout` and differ by `variant`. Three names because
 * what a control should do is a question about the screen.
 */
export type LayoutVariant = "mobile" | "tablet" | "desktop";

/**
 * Which of a layout's two surfaces draws a control.
 *
 * `bar` is the session bar - the phone's at the bottom, the tablet's and the
 * desktop's at the top. `pane` is the header on a pane itself, which a phone
 * does not draw at all.
 *
 * No action is on both surfaces of one layout: the phone carries in its bar
 * what the other two carry on the pane. That is why one value per layout is
 * enough, and it is worth knowing - the two surfaces look like duplicates of
 * each other and are not.
 */
export type ActionSurface = "bar" | "pane";

export interface SessionAction {
	id: string;
	icon: LucideIcon;
	/** i18n key for the tooltip and the accessible name. */
	labelKey: string;
	/** Shown when the action is on and reads differently that way. */
	labelKeyActive?: string;
	/** Where each layout draws it; `null` where that layout has it nowhere. */
	surface: Readonly<Record<LayoutVariant, ActionSurface | null>>;
	/** Onboarding spotlights target the DOM, so the attribute has to travel
	 *  with the action rather than with whichever bar used to carry it. */
	onboarding?: string;
	/** Not every control is neutral: the Claude app link and the remote-control
	 *  toggle have carried their own colour since before this table existed. */
	tone?: "violet" | "amber";
	/** Keeps the rule that separates the pane operations from the rest. */
	separatorBefore?: boolean;
}

/** Shorthands for the surface maps below, so the table stays readable. */
const BAR_EVERYWHERE = {
	mobile: "bar",
	tablet: "bar",
	desktop: "bar",
} as const;

/**
 * Every control in a session bar, in one place.
 *
 * Mobile and desktop/tablet used to be separate component trees, so each action
 * was wired by hand into each of them - and a new one reached whichever tree the
 * person adding it happened to be looking at. That is the source of "the phone
 * never got it": not carelessness, but a structure with no single place to put
 * the answer. The trees are one now; this table is still where the answer goes.
 *
 * `surface` records where each action is **today**, not where it ought to be.
 * The `null`s below look like omissions rather than decisions - a phone can
 * neither zoom nor close a pane, the remote-control toggle is desktop-only -
 * and closing one is a change to the product that someone should choose, one
 * at a time. Recording the current shape first is what makes them visible.
 *
 * A surface says where a control *may* appear, not that it always does: chat
 * needs an agent to talk to, and zoom and close need a second pane to be worth
 * offering. Those conditions belong to the session, not to the screen.
 */
export const SESSION_ACTIONS: readonly SessionAction[] = [
	{
		id: "sessions",
		icon: List,
		labelKey: "action.sessions",
		surface: { mobile: null, tablet: null, desktop: "bar" },
	},
	{
		id: "chat",
		icon: MessageSquare,
		labelKey: "action.chat",
		labelKeyActive: "action.terminal",
		surface: { mobile: "bar", tablet: "pane", desktop: "pane" },
		onboarding: "conversation",
	},
	{
		id: "claude-app",
		icon: ExternalLink,
		labelKey: "session.openInClaudeApp",
		surface: { mobile: "bar", tablet: "pane", desktop: "pane" },
		tone: "violet",
	},
	{
		id: "files",
		icon: FileText,
		labelKey: "action.files",
		surface: { mobile: "bar", tablet: "bar", desktop: "pane" },
		onboarding: "file-browser",
	},
	{
		id: "dashboard",
		icon: BarChart3,
		labelKey: "action.dashboard",
		surface: BAR_EVERYWHERE,
	},
	{
		id: "split-h",
		icon: SplitSquareHorizontal,
		labelKey: "action.splitVertically",
		surface: { mobile: null, tablet: "bar", desktop: "pane" },
		onboarding: "split-pane",
		separatorBefore: true,
	},
	{
		id: "split-v",
		icon: SplitSquareVertical,
		labelKey: "action.splitHorizontally",
		surface: { mobile: null, tablet: "bar", desktop: "pane" },
	},
	{
		id: "zoom",
		icon: Maximize2,
		labelKey: "action.zoom",
		labelKeyActive: "action.unzoom",
		surface: { mobile: null, tablet: "pane", desktop: "pane" },
	},
	{
		id: "close-pane",
		icon: X,
		labelKey: "action.closePane",
		surface: { mobile: null, tablet: "pane", desktop: "pane" },
	},
	{
		id: "reload",
		icon: RefreshCw,
		labelKey: "action.reload",
		surface: { mobile: "bar", tablet: "bar", desktop: "pane" },
		onboarding: "reload",
	},
	{
		id: "keyboard",
		icon: Keyboard,
		labelKey: "action.showKeyboard",
		labelKeyActive: "action.hideKeyboard",
		surface: { mobile: null, tablet: "bar", desktop: null },
		onboarding: "keyboard",
	},
	{
		id: "remote-control",
		icon: Unplug,
		labelKey: "action.remoteControlOff",
		labelKeyActive: "action.remoteControlOn",
		surface: { mobile: null, tablet: null, desktop: "bar" },
		tone: "amber",
	},
] as const;

/** The chat toggle swaps its icon rather than its colour, so it needs the
 *  other one too. Kept beside the table it belongs to. */
export const CHAT_ACTIVE_ICON = TerminalIcon;

/** The actions one layout draws on one of its surfaces, in table order. */
export function actionsFor(
	variant: LayoutVariant,
	surface: ActionSurface = "bar",
): SessionAction[] {
	return SESSION_ACTIONS.filter((a) => a.surface[variant] === surface);
}

/** Whether a layout draws this action at all, on either surface. */
export function actionSurfaceOf(
	id: string,
	variant: LayoutVariant,
): ActionSurface | null {
	return SESSION_ACTIONS.find((a) => a.id === id)?.surface[variant] ?? null;
}

/** Stable hook for the responsive e2e, which asserts that every action its
 *  definition names for a layout is actually rendered there. */
export function actionTestId(id: string): string {
	return `action-${id}`;
}
