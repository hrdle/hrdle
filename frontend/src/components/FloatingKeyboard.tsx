/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import {
	ChevronDown,
	ChevronUp,
	Clock,
	CornerDownLeft,
	Eye,
	EyeOff,
	FileText,
	Maximize2,
	Minus,
	X,
} from "lucide-react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { Keyboard } from "./Keyboard";
import { storageKey } from "../utils/app-storage";

export interface FloatingKeyboardRef {
	setInputText: (text: string) => void;
}

const MINIMIZED_KEY = storageKey("floating-keyboard-minimized");
const TRANSPARENT_KEY = storageKey("floating-keyboard-transparent");

type Orientation = "portrait" | "landscape";

const getOrientation = (): Orientation =>
	window.innerWidth >= window.innerHeight ? "landscape" : "portrait";

const getPositionKey = (
	mode: "keyboard" | "input",
	orientation?: Orientation,
) => {
	const orient = orientation ?? getOrientation();
	return `cchub-floating-keyboard-position-${mode}-${orient}-v3`;
};

interface Position {
	x: number;
	y: number;
}

const getDefaultPosition = (): Position => ({
	x: window.innerWidth / 2 - 200,
	y: window.innerHeight - 300,
});

interface FloatingKeyboardProps {
	visible: boolean;
	onClose: () => void;
	onSend: (char: string) => boolean | undefined;
	onFilePicker?: () => void;
	isUploading?: boolean;
	elevated?: boolean; // Raise z-index above onboarding overlay
}

export const FloatingKeyboard = forwardRef<
	FloatingKeyboardRef,
	FloatingKeyboardProps
>(function FloatingKeyboard(
	{
		visible,
		onClose,
		onSend,
		onFilePicker,
		isUploading = false,
		elevated = false,
	},
	ref,
) {
	const [inputMode, setInputMode] = useState<"keyboard" | "input">("input");
	const [inputValue, setInputValue] = useState("");
	const [showHistory, setShowHistory] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// Input history
	const MAX_HISTORY = 50;
	const HISTORY_KEY = storageKey("input-history");
	const historyRef = useRef<string[]>(
		(() => {
			try {
				return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
			} catch {
				return [];
			}
		})(),
	);
	const historyIndexRef = useRef(-1); // -1 = not browsing history
	const savedInputRef = useRef(""); // save current input when browsing history

	useImperativeHandle(
		ref,
		() => ({
			setInputText: (text: string) => {
				setInputValue(text);
				setInputMode("input");
				setTimeout(() => inputRef.current?.focus(), 100);
			},
		}),
		[],
	);

	// Helper to load position for a mode
	const loadPositionForMode = useCallback(
		(mode: "keyboard" | "input"): Position => {
			try {
				const saved = localStorage.getItem(getPositionKey(mode));
				if (saved) return JSON.parse(saved);
			} catch {}
			return getDefaultPosition();
		},
		[],
	);

	// Position state
	const [position, setPosition] = useState<Position>(() =>
		loadPositionForMode("keyboard"),
	);

	// Minimized state
	const [minimized, setMinimized] = useState(() => {
		try {
			return localStorage.getItem(MINIMIZED_KEY) === "true";
		} catch {}
		return false;
	});

	// Transparent state
	const [transparent, setTransparent] = useState(() => {
		try {
			return localStorage.getItem(TRANSPARENT_KEY) === "true";
		} catch {}
		return false;
	});

	// Dragging state
	const [isDragging, setIsDragging] = useState(false);
	const dragOffset = useRef<Position>({ x: 0, y: 0 });
	const containerRef = useRef<HTMLDivElement>(null);

	// Track orientation for position saving
	const [orientation, setOrientation] = useState<Orientation>(getOrientation);
	const positionRef = useRef(position);
	positionRef.current = position;
	const inputModeRef = useRef(inputMode);
	inputModeRef.current = inputMode;

	// Save position to localStorage (mode + orientation specific)
	useEffect(() => {
		localStorage.setItem(
			getPositionKey(inputMode, orientation),
			JSON.stringify(position),
		);
	}, [position, inputMode, orientation]);

	// On orientation change, save current position and load position for new orientation
	useEffect(() => {
		const handleOrientationChange = () => {
			const newOrientation = getOrientation();
			setOrientation((prev) => {
				if (prev === newOrientation) return prev;
				// Save current position for old orientation before switching
				localStorage.setItem(
					getPositionKey(inputModeRef.current, prev),
					JSON.stringify(positionRef.current),
				);
				// Load position for new orientation (getPositionKey uses newOrientation via getOrientation())
				const saved = loadPositionForMode(inputModeRef.current);
				setPosition(saved);
				return newOrientation;
			});
		};
		window.addEventListener("resize", handleOrientationChange);
		return () => window.removeEventListener("resize", handleOrientationChange);
	}, [loadPositionForMode]);

	// Save minimized state to localStorage
	useEffect(() => {
		localStorage.setItem(MINIMIZED_KEY, String(minimized));
	}, [minimized]);

	// Save transparent state to localStorage
	useEffect(() => {
		localStorage.setItem(TRANSPARENT_KEY, String(transparent));
	}, [transparent]);

	// Drag start handler
	const handleDragStart = useCallback(
		(e: React.MouseEvent | React.TouchEvent) => {
			e.preventDefault();
			const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
			const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;

			dragOffset.current = {
				x: clientX - position.x,
				y: clientY - position.y,
			};
			setIsDragging(true);
		},
		[position],
	);

	// Drag move/end handlers
	useEffect(() => {
		if (!isDragging) return;

		const handleMove = (e: MouseEvent | TouchEvent) => {
			const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
			const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;

			const newX = clientX - dragOffset.current.x;
			const newY = clientY - dragOffset.current.y;

			// Clamp to viewport
			const maxX =
				window.innerWidth - (containerRef.current?.offsetWidth || 400);
			const maxY =
				window.innerHeight - (containerRef.current?.offsetHeight || 200);

			setPosition({
				x: Math.max(0, Math.min(maxX, newX)),
				y: Math.max(0, Math.min(maxY, newY)),
			});
		};

		const handleEnd = () => {
			setIsDragging(false);
		};

		document.addEventListener("mousemove", handleMove);
		document.addEventListener("mouseup", handleEnd);
		document.addEventListener("touchmove", handleMove);
		document.addEventListener("touchend", handleEnd);

		return () => {
			document.removeEventListener("mousemove", handleMove);
			document.removeEventListener("mouseup", handleEnd);
			document.removeEventListener("touchmove", handleMove);
			document.removeEventListener("touchend", handleEnd);
		};
	}, [isDragging]);

	// Mode switch handler (keyboard -> input)
	const handleModeSwitch = useCallback(() => {
		// Save current position for keyboard mode, then load input mode position
		localStorage.setItem(getPositionKey("keyboard"), JSON.stringify(position));
		const newPosition = loadPositionForMode("input");
		setPosition(newPosition);
		setInputMode("input");
		setTimeout(() => inputRef.current?.focus(), 50);
	}, [position, loadPositionForMode]);

	// Mode switch handler (input -> keyboard)
	const handleSwitchToKeyboard = useCallback(() => {
		// Save current position for input mode, then load keyboard mode position
		localStorage.setItem(getPositionKey("input"), JSON.stringify(position));
		const newPosition = loadPositionForMode("keyboard");
		setPosition(newPosition);
		setInputMode("keyboard");
		setInputValue("");
	}, [position, loadPositionForMode]);

	// Save to history
	const addToHistory = (text: string) => {
		const history = historyRef.current;
		// Remove duplicate if exists
		const idx = history.indexOf(text);
		if (idx !== -1) history.splice(idx, 1);
		// Add to front
		history.unshift(text);
		if (history.length > MAX_HISTORY) history.pop();
		try {
			localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
		} catch {}
		historyIndexRef.current = -1;
	};

	// Send text to terminal
	const sendText = (text: string) => {
		// onSend can return false when the terminal is mid-reconnect or there is
		// no active pane. Treat undefined as success (legacy callers). If the
		// send didn't land, keep inputValue and skip addToHistory / clear so the
		// user can retry instead of silently losing the message. #264
		if (text) {
			const textRes = text.includes("\n")
				? onSend(`\x1b[200~${text}\x1b[201~`)
				: onSend(text);
			if (textRes === false) return;
			addToHistory(text);
		}
		const enterRes = onSend("\r");
		if (enterRes === false) return;
		setInputValue("");
		historyIndexRef.current = -1;
		savedInputRef.current = "";
		setShowHistory(false);
	};

	// Input key handler
	// Single Enter = newline, Double Enter (trailing \n + Enter) = send
	const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			if (inputValue.endsWith("\n")) {
				// Double Enter: send content (strip trailing newline)
				e.preventDefault();
				const text = inputValue.replace(/\n$/, "");
				sendText(text);
			}
			// Single Enter: default textarea behavior (insert newline)
		} else if (
			e.key === "Backspace" &&
			!inputValue &&
			!e.nativeEvent.isComposing
		) {
			e.preventDefault();
			onSend("\x7f");
		} else if (!inputValue && !e.nativeEvent.isComposing) {
			const arrowKeys: Record<string, string> = {
				ArrowUp: "\x1b[A",
				ArrowDown: "\x1b[B",
				ArrowLeft: "\x1b[D",
				ArrowRight: "\x1b[C",
			};
			if (arrowKeys[e.key]) {
				e.preventDefault();
				onSend(arrowKeys[e.key]);
			}
		}
	};

	// Toggle minimized
	const toggleMinimize = useCallback(() => {
		setMinimized((prev) => !prev);
	}, []);

	// Toggle transparent
	const toggleTransparent = useCallback(() => {
		setTransparent((prev) => !prev);
	}, []);

	if (!visible) return null;

	// Minimized mini keyboard with arrow up/down and enter
	if (minimized) {
		const miniKeyClass =
			"p-3 text-th-text hover:bg-th-surface-hover active:bg-th-surface-active transition-colors select-none";
		return (
			<div
				ref={containerRef}
				className={`fixed ${elevated ? "z-[10002]" : "z-[60]"}`}
				style={{ left: position.x, top: position.y }}
			>
				<div
					className="flex items-center bg-th-surface border border-th-border rounded-md shadow-lg cursor-move"
					onMouseDown={handleDragStart}
					onTouchStart={handleDragStart}
				>
					{/* Drag handle + Expand */}
					<div className="flex items-center rounded-l-md">
						<div className="flex items-center gap-0.5 px-2 py-3">
							<div className="w-1 h-4 bg-th-surface-active rounded-full" />
							<div className="w-1 h-4 bg-th-surface-active rounded-full" />
						</div>
						<button
							type="button"
							onClick={toggleMinimize}
							className={`${miniKeyClass} rounded-l-md`}
							onMouseDown={(e) => e.stopPropagation()}
							onTouchStart={(e) => e.stopPropagation()}
						>
							<Maximize2 className="w-5 h-5" />
						</button>
					</div>
					{/* Divider */}
					<div className="w-px h-6 bg-th-surface-active" />
					{/* Arrow Up */}
					<button
						type="button"
						onClick={() => onSend("\x1b[A")}
						className={miniKeyClass}
						onMouseDown={(e) => e.stopPropagation()}
						onTouchStart={(e) => e.stopPropagation()}
					>
						<ChevronUp className="w-5 h-5" />
					</button>
					{/* Arrow Down */}
					<button
						type="button"
						onClick={() => onSend("\x1b[B")}
						className={miniKeyClass}
						onMouseDown={(e) => e.stopPropagation()}
						onTouchStart={(e) => e.stopPropagation()}
					>
						<ChevronDown className="w-5 h-5" />
					</button>
					{/* Enter */}
					<button
						type="button"
						onClick={() => onSend("\r")}
						className={miniKeyClass}
						onMouseDown={(e) => e.stopPropagation()}
						onTouchStart={(e) => e.stopPropagation()}
					>
						<CornerDownLeft className="w-5 h-5" strokeWidth={1.5} />
					</button>
					{/* Divider */}
					<div className="w-px h-6 bg-th-surface-active" />
					{/* Close */}
					<button
						type="button"
						onClick={onClose}
						className={`${miniKeyClass} text-th-text-secondary hover:text-th-text rounded-r-md`}
						onMouseDown={(e) => e.stopPropagation()}
						onTouchStart={(e) => e.stopPropagation()}
					>
						<X className="w-4 h-4" />
					</button>
				</div>
			</div>
		);
	}

	// Expanded keyboard
	return (
		<div
			ref={containerRef}
			className={`fixed ${elevated ? "z-[10002]" : "z-[60]"} border border-white/[0.08] rounded-lg shadow-2xl overflow-hidden`}
			style={{
				left: position.x,
				top: position.y,
				width: 420,
				backgroundColor: transparent ? "rgba(17, 24, 39, 0.18)" : "#111111",
				backdropFilter: transparent ? "blur(1px)" : undefined,
				WebkitBackdropFilter: transparent ? "blur(1px)" : undefined,
			}}
		>
			{/* Header - drag handle with segmented control */}
			<div
				className={`flex items-center justify-between px-3 py-1.5 border-b border-white/[0.06] cursor-move select-none`}
				onMouseDown={handleDragStart}
				onTouchStart={handleDragStart}
			>
				<div className="flex items-center gap-2">
					<div className="flex items-center gap-0.5">
						<div className="w-1 h-3 bg-zinc-700 rounded-full" />
						<div className="w-1 h-3 bg-zinc-700 rounded-full" />
					</div>
					<div
						className="inline-flex bg-white/[0.04] rounded p-0.5 ml-1"
						onMouseDown={(e) => e.stopPropagation()}
						onTouchStart={(e) => e.stopPropagation()}
					>
						<button
							type="button"
							onClick={handleSwitchToKeyboard}
							className={`px-2 py-0.5 text-[10px] rounded font-medium transition-colors ${
								inputMode === "keyboard"
									? "bg-white/[0.08] text-zinc-300"
									: "text-zinc-600"
							}`}
						>
							Keyboard
						</button>
						<button
							type="button"
							onClick={handleModeSwitch}
							className={`px-2 py-0.5 text-[10px] rounded font-medium transition-colors ${
								inputMode === "input"
									? "bg-white/[0.08] text-zinc-300"
									: "text-zinc-600"
							}`}
						>
							Input
						</button>
					</div>
				</div>
				<div className="flex items-center gap-0.5">
					{/* Transparent toggle */}
					<button
						type="button"
						onClick={toggleTransparent}
						className={`p-1.5 ${transparent ? "text-blue-400" : "text-zinc-600"} hover:text-zinc-400 rounded transition-colors`}
						onMouseDown={(e) => e.stopPropagation()}
						onTouchStart={(e) => e.stopPropagation()}
					>
						{transparent ? (
							<Eye className="w-3.5 h-3.5" />
						) : (
							<EyeOff className="w-3.5 h-3.5" />
						)}
					</button>
					<button
						type="button"
						onClick={toggleMinimize}
						className="p-1.5 text-zinc-600 hover:text-zinc-400 rounded transition-colors"
						onMouseDown={(e) => e.stopPropagation()}
						onTouchStart={(e) => e.stopPropagation()}
					>
						<Minus className="w-3.5 h-3.5" />
					</button>
					<button
						type="button"
						onClick={onClose}
						className="p-1.5 text-zinc-600 hover:text-zinc-400 rounded transition-colors"
						onMouseDown={(e) => e.stopPropagation()}
						onTouchStart={(e) => e.stopPropagation()}
					>
						<X className="w-3.5 h-3.5" />
					</button>
				</div>
			</div>

			{/* Content */}
			<div className={transparent ? "bg-transparent" : ""}>
				{inputMode === "keyboard" ? (
					<Keyboard
						onSend={onSend}
						onFilePicker={onFilePicker}
						isUploading={isUploading}
						compact={true}
						transparent={transparent}
					/>
				) : (
					<div className="p-2.5">
						{/* History dropdown */}
						{showHistory && historyRef.current.length > 0 && (
							<div className="max-h-28 overflow-y-auto border border-white/[0.06] rounded-md bg-[#0a0a0a] mb-2">
								{historyRef.current.map((item, i) => (
									<button
										type="button"
										// biome-ignore lint/suspicious/noArrayIndexKey: history may contain duplicates; composite index keeps uniqueness
										key={`${i}-${item}`}
										onClick={() => {
											setInputValue(item);
											setShowHistory(false);
											inputRef.current?.focus();
										}}
										className="w-full text-left px-3 py-2 text-[12px] text-zinc-300 hover:bg-white/[0.06] border-b border-white/[0.04] last:border-b-0 truncate transition-colors"
									>
										{item}
									</button>
								))}
							</div>
						)}

						{/* Textarea - full width */}
						<textarea
							ref={inputRef}
							inputMode="text"
							lang="ja"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={handleInputKeyDown}
							autoCapitalize="off"
							autoCorrect="off"
							autoComplete="off"
							spellCheck={false}
							placeholder="Enter twice to send"
							rows={Math.min(Math.max(inputValue.split("\n").length, 1), 5)}
							className="w-full px-3 py-2 bg-[#0a0a0a] border border-white/[0.08] rounded-md text-[13px] text-white placeholder:text-zinc-700 focus:outline-none focus:border-blue-500/50 resize-none mb-1.5"
							style={{ fontSize: "16px" }}
						/>

						{/* Bottom button row */}
						<div className="flex items-center gap-1.5">
							{/* Left group: history, file picker, clear */}
							<button
								type="button"
								onClick={() => {
									historyRef.current = (() => {
										try {
											return JSON.parse(
												localStorage.getItem(HISTORY_KEY) || "[]",
											);
										} catch {
											return [];
										}
									})();
									setShowHistory((prev) => !prev);
								}}
								className={`h-9 w-9 flex items-center justify-center rounded-md transition-colors ${
									showHistory
										? "bg-blue-600 text-white"
										: "bg-white/[0.06] text-zinc-400 active:bg-white/[0.1]"
								}`}
							>
								<Clock className="w-4 h-4" />
							</button>
							{onFilePicker && (
								<button
									type="button"
									onClick={onFilePicker}
									className="h-9 w-9 flex items-center justify-center rounded-md bg-white/[0.06] text-zinc-400 active:bg-white/[0.1]"
									data-onboarding="image-upload"
								>
									<FileText className="w-4 h-4" />
								</button>
							)}
							{inputValue && (
								<button
									type="button"
									onClick={() => {
										setInputValue("");
										inputRef.current?.focus();
									}}
									className="h-9 w-9 flex items-center justify-center rounded-md bg-white/[0.06] text-zinc-500 active:bg-white/[0.1]"
								>
									<X className="w-4 h-4" />
								</button>
							)}

							<div className="flex-1" />

							{/* Right group: arrow up, arrow down, send */}
							<button
								type="button"
								onClick={() => onSend("\x1b[A")}
								className="h-9 w-9 flex items-center justify-center rounded-md bg-white/[0.06] text-zinc-400 active:bg-white/[0.1]"
							>
								<ChevronUp className="w-4 h-4" />
							</button>
							<button
								type="button"
								onClick={() => onSend("\x1b[B")}
								className="h-9 w-9 flex items-center justify-center rounded-md bg-white/[0.06] text-zinc-400 active:bg-white/[0.1]"
							>
								<ChevronDown className="w-4 h-4" />
							</button>
							<button
								type="button"
								onClick={() => sendText(inputValue)}
								className="h-9 w-9 flex items-center justify-center rounded-md bg-blue-600 active:bg-blue-700 text-white"
							>
								<CornerDownLeft className="w-4 h-4" strokeWidth={1.5} />
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
});
