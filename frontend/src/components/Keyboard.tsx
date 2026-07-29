import { CornerDownLeft } from "lucide-react";
import { useCallback, useRef, useState } from "react";

// Keyboard key definition
interface KeyDef {
	label: string;
	key: string; // Character to send
	shiftKey?: string; // Character with Shift
	longKey?: string; // Character on long press
	longLabel?: string; // Long press label
	width?: number; // Relative width (default 1)
	type?: "normal" | "modifier" | "special" | "action" | "layer";
	color?: "green" | "red" | "blue" | "default"; // Action button colors
}

// Top action bar for Claude Code specific actions (the IME toggle is gone - mode switching lives in the header)
const ACTION_BAR: KeyDef[] = [
	{ label: "ESC", key: "\x1b", type: "action" },
	{ label: "TAB", key: "\t", type: "action" },
	{ label: "^C", key: "\x03", type: "action", color: "red" }, // Ctrl+C: interrupt
	{ label: "^E", key: "\x05", type: "action" }, // Ctrl+E: end of line
	{ label: "^O", key: "\x0f", type: "action" }, // Ctrl+O
	{ label: "📁", key: "FILE_PICKER", type: "special" },
];

// Main layer: QWERTY with cursors
const MAIN_ROWS: KeyDef[][] = [
	// Row 1: QWERTY top row
	[
		{ label: "q", key: "q", shiftKey: "Q" },
		{ label: "w", key: "w", shiftKey: "W" },
		{ label: "e", key: "e", shiftKey: "E" },
		{ label: "r", key: "r", shiftKey: "R" },
		{ label: "t", key: "t", shiftKey: "T" },
		{ label: "y", key: "y", shiftKey: "Y" },
		{ label: "u", key: "u", shiftKey: "U" },
		{ label: "i", key: "i", shiftKey: "I" },
		{ label: "o", key: "o", shiftKey: "O" },
		{ label: "p", key: "p", shiftKey: "P" },
		{ label: "⌫", key: "\x7f", width: 1.5, type: "special" },
	],
	// Row 2: ASDF row
	[
		{ label: "a", key: "a", shiftKey: "A" },
		{ label: "s", key: "s", shiftKey: "S" },
		{ label: "d", key: "d", shiftKey: "D" },
		{ label: "f", key: "f", shiftKey: "F" },
		{ label: "g", key: "g", shiftKey: "G" },
		{ label: "h", key: "h", shiftKey: "H" },
		{ label: "j", key: "j", shiftKey: "J" },
		{ label: "k", key: "k", shiftKey: "K" },
		{ label: "l", key: "l", shiftKey: "L" },
		{ label: "↵", key: "\r", width: 1.5, type: "special" },
	],
	// Row 3: ZXCV row
	[
		{ label: "⇧", key: "SHIFT", width: 1.5, type: "modifier" },
		{ label: "z", key: "z", shiftKey: "Z" },
		{ label: "x", key: "x", shiftKey: "X" },
		{ label: "c", key: "c", shiftKey: "C" },
		{ label: "v", key: "v", shiftKey: "V" },
		{ label: "b", key: "b", shiftKey: "B" },
		{ label: "n", key: "n", shiftKey: "N" },
		{ label: "m", key: "m", shiftKey: "M" },
		{ label: "↑", key: "\x1b[A", type: "special" },
		{ label: ".", key: ".", shiftKey: ">", longKey: ">", longLabel: ">" },
	],
	// Row 4: Bottom row with cursors
	[
		{ label: "123", key: "LAYER_NUM", width: 1.5, type: "layer" },
		{ label: "CTRL", key: "CTRL", type: "modifier" },
		{ label: "ALT", key: "ALT", type: "modifier" },
		{ label: "", key: " ", width: 3, type: "special" }, // Space bar
		{ label: ",", key: ",", shiftKey: "<", longKey: "<", longLabel: "<" },
		{ label: "/", key: "/", shiftKey: "?", longKey: "?", longLabel: "?" },
		{ label: "←", key: "\x1b[D", type: "special" },
		{ label: "↓", key: "\x1b[B", type: "special" },
		{ label: "→", key: "\x1b[C", type: "special" },
	],
];

// Numbers and symbols layer
const NUM_ROWS: KeyDef[][] = [
	// Row 1: Numbers
	[
		{ label: "1", key: "1", shiftKey: "!" },
		{ label: "2", key: "2", shiftKey: "@" },
		{ label: "3", key: "3", shiftKey: "#" },
		{ label: "4", key: "4", shiftKey: "$" },
		{ label: "5", key: "5", shiftKey: "%" },
		{ label: "6", key: "6", shiftKey: "^" },
		{ label: "7", key: "7", shiftKey: "&" },
		{ label: "8", key: "8", shiftKey: "*" },
		{ label: "9", key: "9", shiftKey: "(" },
		{ label: "0", key: "0", shiftKey: ")" },
		{ label: "⌫", key: "\x7f", width: 1.5, type: "special" },
	],
	// Row 2: Symbols
	[
		{ label: "-", key: "-", shiftKey: "_" },
		{ label: "=", key: "=", shiftKey: "+" },
		{ label: "[", key: "[", shiftKey: "{" },
		{ label: "]", key: "]", shiftKey: "}" },
		{ label: "\\", key: "\\", shiftKey: "|" },
		{ label: ";", key: ";", shiftKey: ":" },
		{ label: "'", key: "'", shiftKey: '"' },
		{ label: "`", key: "`", shiftKey: "~" },
		{ label: "↵", key: "\r", width: 1.5, type: "special" },
	],
	// Row 3: Shift symbols
	[
		{ label: "⇧", key: "SHIFT", width: 1.5, type: "modifier" },
		{ label: "!", key: "!" },
		{ label: "@", key: "@" },
		{ label: "#", key: "#" },
		{ label: "$", key: "$" },
		{ label: "%", key: "%" },
		{ label: "^", key: "^" },
		{ label: "&", key: "&" },
		{ label: "↑", key: "\x1b[A", type: "special" },
		{ label: "*", key: "*" },
	],
	// Row 4: Bottom with cursors
	[
		{ label: "ABC", key: "LAYER_MAIN", width: 1.5, type: "layer" },
		{ label: "CTRL", key: "CTRL", type: "modifier" },
		{ label: "ALT", key: "ALT", type: "modifier" },
		{ label: "", key: " ", width: 3, type: "special" },
		{ label: "(", key: "(" },
		{ label: ")", key: ")" },
		{ label: "←", key: "\x1b[D", type: "special" },
		{ label: "↓", key: "\x1b[B", type: "special" },
		{ label: "→", key: "\x1b[C", type: "special" },
	],
];

type Layer = "main" | "num";

interface KeyboardProps {
	onSend: (char: string) => void;
	onFilePicker?: () => void;
	onModeSwitch?: () => void;
	isUploading?: boolean;
	compact?: boolean;
	transparent?: boolean;
	className?: string;
	inputMode?: "keyboard" | "input";
	onInputModeChange?: (mode: "keyboard" | "input") => void;
	showModeToggle?: boolean;
}

export function Keyboard({
	onSend,
	onFilePicker,
	onModeSwitch,
	isUploading = false,
	compact = false,
	transparent = false,
	className = "",
	inputMode = "input",
	onInputModeChange,
	showModeToggle = false,
}: KeyboardProps) {
	const [layer, setLayer] = useState<Layer>("main");
	const [ctrlPressed, setCtrlPressed] = useState(false);
	const [altPressed, setAltPressed] = useState(false);
	const [shiftPressed, setShiftPressed] = useState(false);

	// Long press support
	const longPressTimerRef = useRef<number | null>(null);
	const longPressFiredRef = useRef(false);

	// Get current keyboard rows based on layer
	const getCurrentRows = (): KeyDef[][] => {
		switch (layer) {
			case "num":
				return NUM_ROWS;
			default:
				return MAIN_ROWS;
		}
	};

	// Send keyboard key with modifiers
	const sendKeyPress = useCallback(
		(keyDef: KeyDef) => {
			// Handle layer switching
			if (keyDef.type === "layer") {
				if (keyDef.key === "LAYER_MAIN") setLayer("main");
				else if (keyDef.key === "LAYER_NUM") setLayer("num");
				return;
			}

			// Handle modifier keys
			if (keyDef.type === "modifier") {
				if (keyDef.key === "CTRL") {
					setCtrlPressed(!ctrlPressed);
				} else if (keyDef.key === "ALT") {
					setAltPressed(!altPressed);
				} else if (keyDef.key === "SHIFT") {
					setShiftPressed(!shiftPressed);
				}
				return;
			}

			// Handle Shift+Enter for multiline input (send backslash + enter)
			if (shiftPressed && keyDef.key === "\r") {
				onSend("\\\r"); // Backslash + Enter for line continuation
				setShiftPressed(false);
				return;
			}

			// Handle Shift+Tab as VT back-tab (CSI Z). Claude Code uses this
			// to cycle auto-mode / plan-mode / accept-edits (the "shift+tab to
			// cycle" hint in its status line). The fallthrough below would
			// otherwise resolve to "\t".toUpperCase() === "\t" and lose the
			// Shift entirely.
			if (shiftPressed && keyDef.key === "\t") {
				onSend("\x1b[Z");
				setShiftPressed(false);
				return;
			}

			// Determine the character to send
			let char = shiftPressed
				? keyDef.shiftKey || keyDef.key.toUpperCase()
				: keyDef.key;

			// Apply Ctrl modifier
			if (ctrlPressed && char.length === 1) {
				const code = char.toLowerCase().charCodeAt(0) - 96;
				if (code > 0 && code < 27) {
					char = String.fromCharCode(code);
				}
				setCtrlPressed(false);
			}

			// Apply Alt modifier (ESC prefix)
			if (altPressed) {
				char = `\x1b${char}`;
				setAltPressed(false);
			}

			// Reset shift after use (one-shot)
			if (shiftPressed) {
				setShiftPressed(false);
			}

			onSend(char);
		},
		[ctrlPressed, altPressed, shiftPressed, onSend],
	);

	// Handle long press for alternative characters
	const sendLongPress = useCallback(
		(keyDef: KeyDef) => {
			if (keyDef.longKey) {
				onSend(keyDef.longKey);
				setCtrlPressed(false);
				setAltPressed(false);
				setShiftPressed(false);
			}
		},
		[onSend],
	);

	// Keyboard key component
	const KeyboardKey = ({ keyDef }: { keyDef: KeyDef }) => {
		const handleStart = (e: React.MouseEvent | React.TouchEvent) => {
			e.preventDefault();
			// Clear any existing timer (prevents duplicate from touch+mouse double-fire)
			if (longPressTimerRef.current) {
				clearTimeout(longPressTimerRef.current);
				longPressTimerRef.current = null;
			}
			longPressFiredRef.current = false;

			if (keyDef.longKey) {
				longPressTimerRef.current = window.setTimeout(() => {
					longPressFiredRef.current = true;
					sendLongPress(keyDef);
				}, 400);
			}
		};

		const handleEnd = (e: React.MouseEvent | React.TouchEvent) => {
			e.preventDefault();
			if (longPressTimerRef.current) {
				clearTimeout(longPressTimerRef.current);
				longPressTimerRef.current = null;
			}
			if (!longPressFiredRef.current) {
				sendKeyPress(keyDef);
			}
			longPressFiredRef.current = false;
		};

		const handleCancel = () => {
			if (longPressTimerRef.current) {
				clearTimeout(longPressTimerRef.current);
				longPressTimerRef.current = null;
			}
			longPressFiredRef.current = false;
		};

		// Determine display label based on shift state
		const displayLabel =
			keyDef.type === "modifier" ||
			keyDef.type === "special" ||
			keyDef.type === "layer" ||
			keyDef.type === "action"
				? keyDef.label
				: shiftPressed && keyDef.shiftKey
					? keyDef.shiftKey
					: keyDef.label;

		// Check if this modifier is active
		const isActive =
			keyDef.type === "modifier" &&
			((keyDef.key === "CTRL" && ctrlPressed) ||
				(keyDef.key === "ALT" && altPressed) ||
				(keyDef.key === "SHIFT" && shiftPressed));

		const width = keyDef.width || 1;

		// Large icon for Enter key
		const isEnterKey = keyDef.label === "↵";
		const isSpaceKey = keyDef.key === " " && keyDef.type === "special";

		// Get background color
		const getBgColor = () => {
			if (transparent) {
				if (isActive) return "bg-blue-600/30";
				if (keyDef.color === "red") return "bg-red-500/15 active:bg-red-500/25";
				if (keyDef.type === "modifier" || keyDef.type === "layer")
					return "bg-white/[0.06] active:bg-white/[0.12]";
				return "bg-white/[0.08] active:bg-white/[0.15]";
			}
			if (isActive) return "bg-blue-600";
			if (keyDef.color === "red") return "bg-red-500/15 active:bg-red-500/25";
			if (keyDef.type === "modifier" || keyDef.type === "layer")
				return "bg-white/[0.06] active:bg-white/[0.12]";
			return "bg-white/[0.08] active:bg-white/[0.15]";
		};

		// Enter icon
		const EnterIcon = () => (
			<CornerDownLeft
				className={compact ? "w-5 h-5" : "w-6 h-6"}
				strokeWidth={1.5}
			/>
		);

		// Get text color
		const getTextColor = () => {
			if (isActive) return "text-white";
			if (keyDef.color === "red") return "text-red-400";
			if (keyDef.type === "modifier" || keyDef.type === "layer")
				return "text-blue-400";
			return "text-white";
		};

		return (
			<button
				type="button"
				onMouseDown={handleStart}
				onMouseUp={handleEnd}
				onMouseLeave={handleCancel}
				onTouchStart={handleStart}
				onTouchEnd={handleEnd}
				onTouchCancel={handleCancel}
				onContextMenu={(e) => e.preventDefault()}
				className={`
          ${compact ? "h-8 text-[11px]" : "h-[38px] text-[13px]"} font-medium select-none relative
          rounded-md m-0.5 flex items-center justify-center
          ${getBgColor()} ${getTextColor()}
          ${keyDef.type === "modifier" || keyDef.type === "layer" ? (compact ? "text-[9px]" : "text-[10px]") : ""}
        `}
				style={{ flex: width, minWidth: 0 }}
			>
				{isEnterKey ? <EnterIcon /> : isSpaceKey ? "" : displayLabel}
				{keyDef.longLabel && !shiftPressed && !isEnterKey && (
					<span
						className={`absolute top-0.5 right-1 ${compact ? "text-[7px]" : "text-[9px]"} text-zinc-500`}
					>
						{keyDef.longLabel}
					</span>
				)}
			</button>
		);
	};

	// Action button component
	const ActionButton = ({ keyDef }: { keyDef: KeyDef }) => {
		const handleClick = () => {
			if (keyDef.key === "FILE_PICKER") {
				onFilePicker?.();
			} else if (keyDef.key === "MODE_SWITCH") {
				onModeSwitch?.();
			} else if (keyDef.key === "\t" && shiftPressed) {
				// Shift+Tab → VT back-tab (CSI Z). TAB lives in the action bar and
				// is sent directly from here, so the shift modifier toggled in the
				// main keyboard would otherwise be ignored. Claude Code uses
				// back-tab to cycle auto-mode / plan-mode / accept-edits.
				onSend("\x1b[Z");
				setShiftPressed(false);
			} else {
				onSend(keyDef.key);
			}
		};

		const getBgColor = () => {
			if (keyDef.color === "red")
				return "bg-red-500/15 text-red-400 active:bg-white/[0.12]";
			return "bg-white/[0.06] text-zinc-400 active:bg-white/[0.12]";
		};

		// Handle uploading state for file picker
		if (keyDef.key === "FILE_PICKER" && isUploading) {
			return (
				<button
					type="button"
					disabled
					className={`${compact ? "h-[26px] text-[10px]" : "h-[30px] text-[11px]"} min-w-[34px] px-1.5 flex items-center justify-center rounded-md font-medium select-none bg-white/[0.06] text-zinc-600`}
					data-onboarding="image-upload"
				>
					⏳
				</button>
			);
		}

		// Add data-onboarding attributes for special buttons
		const getOnboardingAttr = () => {
			if (keyDef.key === "FILE_PICKER") return "image-upload";
			return undefined;
		};

		return (
			<button
				type="button"
				onClick={handleClick}
				onContextMenu={(e) => e.preventDefault()}
				className={`${compact ? "h-[26px] text-[10px]" : "h-[30px] text-[11px]"} min-w-[34px] px-1.5 flex items-center justify-center rounded-md font-medium select-none ${getBgColor()}`}
				data-onboarding={getOnboardingAttr()}
			>
				{keyDef.key === "\t" && shiftPressed ? "⇧TAB" : keyDef.label}
			</button>
		);
	};

	return (
		<div
			className={`${transparent ? "bg-transparent" : "bg-[#111111]"} pb-1 ${className}`}
		>
			{/* Mode toggle + Action bar (single row) */}
			<div className="flex items-center gap-1 px-0.5 py-1">
				{showModeToggle && (
					<div className="inline-flex bg-white/[0.04] rounded-md p-0.5 shrink-0">
						<button
							type="button"
							onClick={() => onInputModeChange?.("keyboard")}
							className={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${
								inputMode === "keyboard"
									? "bg-white/[0.08] text-zinc-300"
									: "text-zinc-600"
							}`}
						>
							Keyboard
						</button>
						<button
							type="button"
							onClick={() => onInputModeChange?.("input")}
							className={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${
								inputMode === "input"
									? "bg-white/[0.08] text-zinc-300"
									: "text-zinc-600"
							}`}
						>
							Input
						</button>
					</div>
				)}
				<div className="flex gap-1 overflow-x-auto">
					{ACTION_BAR.map((keyDef, index) => (
						<ActionButton
							// biome-ignore lint/suspicious/noArrayIndexKey: ACTION_BAR is a static, never-reordered config
							key={index}
							keyDef={keyDef}
						/>
					))}
				</div>
			</div>

			{/* Separator */}
			<div className="h-px bg-white/[0.04] mx-0.5" />

			{/* Main keyboard */}
			<div className="px-0.5 py-1 space-y-[3px]">
				{getCurrentRows().map((row, rowIndex) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: keyboard rows are static, never reordered
						key={rowIndex}
						className="flex gap-[3px]"
					>
						{row.map((keyDef, keyIndex) => (
							<KeyboardKey
								// biome-ignore lint/suspicious/noArrayIndexKey: keys within a row are static, never reordered
								key={`${rowIndex}-${keyIndex}`}
								keyDef={keyDef}
							/>
						))}
					</div>
				))}
			</div>
		</div>
	);
}
