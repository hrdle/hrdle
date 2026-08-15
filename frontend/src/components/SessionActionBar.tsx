import { useTranslation } from "react-i18next";
import {
	CHAT_ACTIVE_ICON,
	type LayoutVariant,
	actionTestId,
	actionsFor,
} from "../actions/sessionActions";

/** What a layout supplies for one action: what it does, and whether it is on. */
export interface SessionActionHandler {
	onSelect: () => void;
	/** Toggles read differently and often look different when on. */
	active?: boolean;
	/** The action exists on this layout but not for this session - no agent to
	 *  chat with, no Claude app session to open. */
	hidden?: boolean;
}

interface SessionActionBarProps {
	variant: LayoutVariant;
	handlers: Record<string, SessionActionHandler | undefined>;
	className?: string;
}

/**
 * Per-variant chrome. The three bars were written separately and do not look
 * alike - a phone's controls are finger-sized and light on a dark bar, the
 * desktop's are small and mark their state with a filled background - so the
 * differences are kept, listed in one place instead of three files.
 */
const CHROME: Record<
	LayoutVariant,
	{ button: string; idle: string; on: string; icon: string }
> = {
	mobile: {
		button: "p-3 transition-colors",
		idle: "text-zinc-300 hover:text-white active:text-white",
		on: "text-zinc-300 hover:text-white active:text-white",
		icon: "w-5 h-5",
	},
	tablet: {
		button: "p-2 transition-colors",
		idle: "text-zinc-500 hover:text-zinc-300 active:text-zinc-200",
		on: "text-blue-400",
		icon: "w-[18px] h-[18px]",
	},
	desktop: {
		button: "p-1.5 rounded-md transition-colors",
		idle: "text-zinc-600 hover:text-zinc-400",
		on: "text-blue-400 bg-blue-500/20",
		icon: "w-[18px] h-[18px]",
	},
};

const TONES: Record<string, { idle: string; on: string }> = {
	violet: {
		idle: "text-violet-400 hover:text-violet-300 active:text-violet-200",
		on: "text-violet-400 hover:text-violet-300 active:text-violet-200",
	},
	amber: {
		idle: "text-zinc-600 hover:text-zinc-400",
		on: "text-amber-400 bg-amber-500/20",
	},
};

/**
 * The session controls for one layout, rendered from the shared definition.
 *
 * A layout says what each action *does*; which actions exist, what they are
 * called and where they appear is `SESSION_ACTIONS`. An action a layout has no
 * handler for is not rendered - and the responsive e2e fails, which is the
 * point: "the phone never got it" used to be invisible until someone reached
 * for the control on a phone.
 */
export function SessionActionBar({
	variant,
	handlers,
	className,
}: SessionActionBarProps) {
	const { t } = useTranslation();
	const chrome = CHROME[variant];

	return (
		<div className={className ?? "flex items-center gap-1 shrink-0"}>
			{actionsFor(variant).map((action) => {
				const handler = handlers[action.id];
				if (!handler || handler.hidden) return null;

				const active = handler.active ?? false;
				const tone = action.tone ? TONES[action.tone] : undefined;
				const state = active
					? (tone?.on ?? chrome.on)
					: (tone?.idle ?? chrome.idle);
				const label = t(
					active && action.labelKeyActive
						? action.labelKeyActive
						: action.labelKey,
				);
				const Icon =
					action.id === "chat" && active ? CHAT_ACTIVE_ICON : action.icon;

				return (
					<div key={action.id} className="flex items-center">
						{action.separatorBefore && (
							<div className="w-px h-4 bg-white/[0.06] mx-0.5" />
						)}
						<button
							type="button"
							onClick={handler.onSelect}
							className={`${chrome.button} ${state}`}
							title={label}
							aria-label={label}
							data-testid={actionTestId(action.id)}
							data-onboarding={action.onboarding}
						>
							<Icon className={chrome.icon} />
						</button>
					</div>
				);
			})}
		</div>
	);
}
