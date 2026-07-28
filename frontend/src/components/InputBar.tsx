/** biome-ignore-all lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: legacy click-on-div UI; keyboard navigation provided via main shortcuts */
import {
	ChevronDown,
	ChevronUp,
	Clock,
	CornerDownLeft,
	FileText,
	X,
} from "lucide-react";
import {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { uploadImage } from "../utils/upload-image";
import { Keyboard } from "./Keyboard";
import { storageKey } from "../utils/app-storage";

export type InputMode = "hidden" | "shortcuts" | "input";

export interface InputBarRef {
	setText: (text: string) => void;
}

interface InputBarProps {
	inputMode: InputMode;
	setInputMode: (mode: InputMode) => void;
	sendRef: React.RefObject<(data: string) => void>;
	fitTerminal: () => void;
	isTablet: boolean;
	overlayContent?: React.ReactNode;
	onOverlayTap?: () => void;
	showOverlay?: boolean;
	hideKeyboard?: boolean;
	/** Peer this terminal targets; used to route image uploads. Unset = local. */
	peerId?: string;
}

export const InputBar = memo(
	forwardRef<InputBarRef, InputBarProps>(function InputBar(
		{
			inputMode,
			setInputMode,
			sendRef,
			fitTerminal,
			isTablet,
			overlayContent,
			onOverlayTap,
			showOverlay = true,
			hideKeyboard,
			peerId,
		},
		ref,
	) {
		const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
		const fileInputRef = useRef<HTMLInputElement>(null);
		const [inputValue, setInputValue] = useState("");
		const [showInputHistory, setShowInputHistory] = useState(false);

		useImperativeHandle(
			ref,
			() => ({
				setText: (text: string) => {
					setInputValue(text);
					setInputMode("input");
					setTimeout(() => inputRef.current?.focus(), 100);
				},
			}),
			[setInputMode],
		);
		const inputHistoryRef = useRef<string[]>(
			(() => {
				try {
					return JSON.parse(
						localStorage.getItem(storageKey("input-history")) || "[]",
					);
				} catch {
					return [];
				}
			})(),
		);
		const [isUploading, setIsUploading] = useState(false);
		const [isAnimating, setIsAnimating] = useState(false);
		const [showHint, setShowHint] = useState(true);
		const hintTimeoutRef = useRef<number | null>(null);

		// Keyboard position for tablet
		const [keyboardPosition, setKeyboardPosition] = useState<"left" | "right">(
			"right",
		);
		const [showPositionToggle, setShowPositionToggle] = useState(true);
		const positionToggleTimeoutRef = useRef<number | null>(null);

		// Swipe handling
		const inputBarSwipeRef = useRef<{ startX: number; startY: number } | null>(
			null,
		);

		// Clear the auto-hide timers on unmount so they don't fire after the
		// component is gone (it returns null in "hidden" mode).
		useEffect(() => {
			return () => {
				if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current);
				if (positionToggleTimeoutRef.current)
					clearTimeout(positionToggleTimeoutRef.current);
			};
		}, []);

		// Auto-hide position toggle
		const resetPositionToggleTimer = useCallback(() => {
			if (positionToggleTimeoutRef.current)
				clearTimeout(positionToggleTimeoutRef.current);
			positionToggleTimeoutRef.current = window.setTimeout(
				() => setShowPositionToggle(false),
				3000,
			);
		}, []);

		const handlePositionToggle = () => {
			setKeyboardPosition((p) => (p === "right" ? "left" : "right"));
			setShowPositionToggle(true);
			resetPositionToggleTimer();
		};

		const addToInputHistory = (text: string) => {
			const history = inputHistoryRef.current;
			const idx = history.indexOf(text);
			if (idx !== -1) history.splice(idx, 1);
			history.unshift(text);
			if (history.length > 50) history.pop();
			try {
				localStorage.setItem(storageKey("input-history"), JSON.stringify(history));
			} catch {}
		};

		const handleInputKeyDown = (
			e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
		) => {
			if (e.key === "Enter" && !e.nativeEvent.isComposing) {
				if (inputValue.endsWith("\n")) {
					e.preventDefault();
					const text = inputValue.replace(/\n$/, "");
					if (text) {
						addToInputHistory(text);
						if (text.includes("\n")) {
							sendRef.current(`\x1b[200~${text}\x1b[201~`);
						} else {
							sendRef.current(text);
						}
					}
					sendRef.current("\r");
					setInputValue("");
					setShowInputHistory(false);
				}
			} else if (
				e.key === "Backspace" &&
				!inputValue &&
				!e.nativeEvent.isComposing
			) {
				e.preventDefault();
				sendRef.current("\x7f");
			} else if (!inputValue && !e.nativeEvent.isComposing) {
				const arrowKeys: Record<string, string> = {
					ArrowUp: "\x1b[A",
					ArrowDown: "\x1b[B",
					ArrowLeft: "\x1b[D",
					ArrowRight: "\x1b[C",
				};
				if (arrowKeys[e.key]) {
					e.preventDefault();
					sendRef.current(arrowKeys[e.key]);
				}
			}
		};

		const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;
			e.target.value = "";
			setIsUploading(true);
			try {
				const result = await uploadImage(file, peerId);
				if (result.ok && result.path) {
					sendRef.current(result.path);
				} else {
					console.error("Upload failed:", result.error);
					sendRef.current(
						`\r\n[Upload error: ${result.error || "Unknown error"}]\r\n`,
					);
				}
			} finally {
				setIsUploading(false);
			}
		};

		const handleOpenFilePicker = () => fileInputRef.current?.click();

		const handleExtractUrls = () => {
			// URL extraction is handled by DesktopLayout via terminalRef.extractUrls();
			// mobile path is not yet wired up.
		};

		const handleInputBarTouchStart = (e: React.TouchEvent) => {
			inputBarSwipeRef.current = {
				startX: e.touches[0].clientX,
				startY: e.touches[0].clientY,
			};
		};

		const handleInputBarTouchEnd = (e: React.TouchEvent) => {
			if (!inputBarSwipeRef.current) return;
			const deltaX =
				e.changedTouches[0].clientX - inputBarSwipeRef.current.startX;
			const deltaY =
				e.changedTouches[0].clientY - inputBarSwipeRef.current.startY;

			if (Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY)) {
				setShowHint(true);
				if (hintTimeoutRef.current) clearTimeout(hintTimeoutRef.current);
				hintTimeoutRef.current = window.setTimeout(
					() => setShowHint(false),
					3000,
				);

				if (deltaX > 0 && inputMode === "shortcuts") {
					setIsAnimating(true);
					setInputMode("input");
					setTimeout(() => {
						setIsAnimating(false);
						inputRef.current?.focus();
						fitTerminal();
					}, 350);
				} else if (deltaX < 0 && inputMode === "input") {
					setIsAnimating(true);
					setInputMode("shortcuts");
					setInputValue("");
					setTimeout(() => {
						setIsAnimating(false);
						fitTerminal();
					}, 350);
				}
			}
			inputBarSwipeRef.current = null;
		};

		if (hideKeyboard || inputMode === "hidden") return null;

		return (
			<div
				className="shrink-0 bg-th-bg border-t border-green-500 relative"
				onTouchStart={handleInputBarTouchStart}
				onTouchEnd={handleInputBarTouchEnd}
			>
				{showOverlay && overlayContent}

				{!showOverlay && overlayContent && onOverlayTap && (
					<div
						className="h-4 flex items-center justify-center"
						onClick={onOverlayTap}
					>
						<div className="w-10 h-1 bg-th-surface-active rounded-full" />
					</div>
				)}

				<input
					type="file"
					accept="image/png,image/jpeg,image/gif,image/webp"
					className="hidden"
					ref={fileInputRef}
					onChange={handleFileSelect}
				/>

				{!overlayContent && (
					<div
						className={`bg-th-surface flex justify-between items-center overflow-hidden transition-all duration-300 ${
							isTablet
								? showPositionToggle
									? "px-2 py-1"
									: "h-0 py-0"
								: "px-2 py-1"
						}`}
						onClick={() =>
							isTablet && !showPositionToggle && setShowPositionToggle(true)
						}
					>
						{(!isTablet || showPositionToggle) && (
							<span className="text-xs text-th-text-muted">
								{showHint && "スクロールで閉じる"}
							</span>
						)}
						{isTablet && inputMode === "shortcuts" && showPositionToggle && (
							<button
								type="button"
								onClick={handlePositionToggle}
								className="px-2 py-0.5 bg-th-surface-hover text-th-text-secondary text-xs rounded"
							>
								{keyboardPosition === "right" ? "← 左へ" : "右へ →"}
							</button>
						)}
					</div>
				)}

				{isTablet && !showPositionToggle && inputMode === "shortcuts" && (
					<div
						className="h-2 bg-th-surface flex items-center justify-center"
						onClick={() => setShowPositionToggle(true)}
					>
						<div className="w-8 h-0.5 bg-th-surface-active rounded-full" />
					</div>
				)}

				{isAnimating ? (
					<div className="overflow-hidden">
						<div
							className="flex transition-transform duration-300 ease-out"
							style={{
								transform:
									inputMode === "input" ? "translateX(-100%)" : "translateX(0)",
							}}
						>
							<div
								className={`w-full flex-shrink-0 ${isTablet ? "flex" : ""} ${isTablet ? (keyboardPosition === "left" ? "justify-start" : "justify-end") : ""}`}
							>
								<div className={isTablet ? "w-1/3 max-w-sm" : "w-full"}>
									<Keyboard
										onSend={(char) => sendRef.current(char)}
										onFilePicker={handleOpenFilePicker}
										onUrlExtract={handleExtractUrls}
										isUploading={isUploading}
										compact={isTablet}
										showModeToggle={true}
										inputMode="keyboard"
										onInputModeChange={(mode) => {
											if (mode === "input") {
												setIsAnimating(true);
												setInputMode("input");
												setTimeout(() => {
													setIsAnimating(false);
													inputRef.current?.focus();
													fitTerminal();
												}, 350);
											}
										}}
									/>
								</div>
							</div>
							<div className="w-full flex-shrink-0 p-2 bg-th-bg">
								{showInputHistory && inputHistoryRef.current.length > 0 && (
									<div className="max-h-40 overflow-y-auto border border-th-border rounded bg-th-bg mb-1">
										{inputHistoryRef.current.map((item, i) => (
											<button
												type="button"
												// biome-ignore lint/suspicious/noArrayIndexKey: history may contain duplicates; composite index keeps uniqueness
												key={`${i}-${item}`}
												onClick={() => {
													setInputValue(item);
													setShowInputHistory(false);
													inputRef.current?.focus();
												}}
												onContextMenu={(e) => e.preventDefault()}
												className="w-full text-left px-3 py-2 text-sm text-th-text hover:bg-th-surface-hover active:bg-th-surface-active border-b border-th-border/30 last:border-b-0 truncate"
											>
												{item}
											</button>
										))}
									</div>
								)}
								<div className="flex gap-1.5">
									<input
										type="text"
										inputMode="text"
										lang="ja"
										value={inputValue}
										onChange={(e) => setInputValue(e.target.value)}
										onKeyDown={handleInputKeyDown}
										autoCapitalize="off"
										autoCorrect="off"
										autoComplete="off"
										spellCheck={false}
										placeholder="日本語入力可 - Enterで送信"
										className="flex-1 px-3 py-2 bg-th-surface border border-th-border rounded text-th-text placeholder-th-text-muted focus:outline-none focus:border-green-500"
										style={{ fontSize: "16px" }}
									/>
									<button
										type="button"
										onClick={() => {
											inputHistoryRef.current = (() => {
												try {
													return JSON.parse(
														localStorage.getItem(storageKey("input-history")) || "[]",
													);
												} catch {
													return [];
												}
											})();
											setShowInputHistory((prev) => !prev);
										}}
										className={`px-2.5 rounded border border-th-border ${showInputHistory ? "bg-blue-700 text-white border-blue-700" : "bg-th-surface text-th-text-secondary"}`}
									>
										<svg
											aria-hidden="true"
											className="w-5 h-5"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth={2}
												d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
											/>
										</svg>
									</button>
								</div>
							</div>
						</div>
					</div>
				) : inputMode === "shortcuts" ? (
					<div
						className={`${isTablet ? "flex" : ""} ${isTablet ? (keyboardPosition === "left" ? "justify-start" : "justify-end") : ""}`}
					>
						<input
							type="text"
							inputMode="none"
							className="absolute opacity-0 w-0 h-0 pointer-events-none"
							tabIndex={-1}
							ref={inputRef as React.RefObject<HTMLInputElement | null>}
						/>
						<div
							className={isTablet ? "w-1/3 max-w-sm" : "w-full"}
							data-onboarding="keyboard"
						>
							<Keyboard
								onSend={(char) => sendRef.current(char)}
								onFilePicker={handleOpenFilePicker}
								onUrlExtract={handleExtractUrls}
								isUploading={isUploading}
								compact={isTablet}
								showModeToggle={true}
								inputMode="keyboard"
								onInputModeChange={(mode) => {
									if (mode === "input") {
										setIsAnimating(true);
										setInputMode("input");
										setTimeout(() => {
											setIsAnimating(false);
											inputRef.current?.focus();
											fitTerminal();
										}, 350);
									}
								}}
							/>
						</div>
					</div>
				) : (
					<div className="bg-[#111111]">
						<div className="flex items-center justify-between px-2 py-1.5 border-b border-white/[0.04]">
							<div className="inline-flex bg-white/[0.04] rounded-md p-0.5">
								<button
									type="button"
									onClick={() => {
										setIsAnimating(true);
										setInputMode("shortcuts");
										setInputValue("");
										setShowInputHistory(false);
										setTimeout(() => {
											setIsAnimating(false);
											fitTerminal();
										}, 350);
									}}
									className="px-3 py-1 text-[11px] text-zinc-600 rounded font-medium transition-colors"
								>
									キーボード
								</button>
								<button
									type="button"
									className="px-3 py-1 text-[11px] bg-white/[0.08] text-zinc-300 rounded font-medium"
								>
									入力
								</button>
							</div>
							<button
								type="button"
								onClick={() => {
									setInputMode("hidden");
									fitTerminal();
								}}
								className="p-1.5 text-zinc-600 hover:text-zinc-400 rounded transition-colors"
							>
								<X className="w-4 h-4" />
							</button>
						</div>

						<div className="px-2.5 pt-2 pb-1.5">
							{showInputHistory && inputHistoryRef.current.length > 0 && (
								<div className="max-h-28 overflow-y-auto border border-white/[0.06] rounded-md bg-[#0a0a0a] mb-2">
									{inputHistoryRef.current.map((item, i) => (
										<button
											type="button"
											// biome-ignore lint/suspicious/noArrayIndexKey: history may contain duplicates; composite index keeps uniqueness
											key={`${i}-${item}`}
											onClick={() => {
												setInputValue(item);
												setShowInputHistory(false);
												inputRef.current?.focus();
											}}
											onContextMenu={(e) => e.preventDefault()}
											className="w-full text-left px-3 py-2 text-[12px] text-zinc-300 hover:bg-white/[0.06] border-b border-white/[0.04] last:border-b-0 truncate transition-colors"
										>
											{item}
										</button>
									))}
								</div>
							)}
							<textarea
								ref={inputRef as React.RefObject<HTMLTextAreaElement | null>}
								inputMode="text"
								lang="ja"
								value={inputValue}
								onChange={(e) => setInputValue(e.target.value)}
								onKeyDown={handleInputKeyDown}
								autoCapitalize="off"
								autoCorrect="off"
								autoComplete="off"
								spellCheck={false}
								// biome-ignore lint/a11y/noAutofocus: required to show OS keyboard on mode switch
								autoFocus
								placeholder="日本語入力 - Enter×2で送信"
								rows={Math.min(Math.max(inputValue.split("\n").length, 1), 5)}
								className="w-full px-3 py-2 bg-[#0a0a0a] border border-white/[0.08] rounded-md text-[13px] text-white placeholder:text-zinc-700 focus:outline-none focus:border-blue-500/50 resize-none mb-1.5"
								style={{ fontSize: "16px" }}
							/>
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									onClick={() => {
										inputHistoryRef.current = (() => {
											try {
												return JSON.parse(
													localStorage.getItem(storageKey("input-history")) || "[]",
												);
											} catch {
												return [];
											}
										})();
										setShowInputHistory((prev) => !prev);
									}}
									className={`h-9 w-14 flex items-center justify-center rounded-md transition-colors ${
										showInputHistory
											? "bg-blue-600 text-white"
											: "bg-white/[0.06] text-zinc-400 active:bg-white/[0.1]"
									}`}
								>
									<Clock className="w-4 h-4" />
								</button>
								<button
									type="button"
									onClick={handleOpenFilePicker}
									disabled={isUploading}
									className={`h-9 w-14 flex items-center justify-center rounded-md ${
										isUploading
											? "bg-white/[0.06] text-zinc-600"
											: "bg-white/[0.06] text-zinc-400 active:bg-white/[0.1]"
									}`}
								>
									<FileText className="w-4 h-4" />
								</button>
								{inputValue && (
									<button
										type="button"
										onClick={() => {
											setInputValue("");
											inputRef.current?.focus();
										}}
										className="h-9 w-14 flex items-center justify-center rounded-md bg-white/[0.06] text-zinc-500 active:bg-white/[0.1]"
									>
										<X className="w-4 h-4" />
									</button>
								)}
								<div className="flex-1" />
								<button
									type="button"
									onClick={() => sendRef.current("\x1b[A")}
									className="h-9 w-14 flex items-center justify-center rounded-md bg-white/[0.06] text-zinc-400 active:bg-white/[0.1]"
								>
									<ChevronUp className="w-4 h-4" />
								</button>
								<button
									type="button"
									onClick={() => sendRef.current("\x1b[B")}
									className="h-9 w-14 flex items-center justify-center rounded-md bg-white/[0.06] text-zinc-400 active:bg-white/[0.1]"
								>
									<ChevronDown className="w-4 h-4" />
								</button>
								<button
									type="button"
									onClick={() => {
										if (inputValue) {
											addToInputHistory(inputValue);
											if (inputValue.includes("\n")) {
												sendRef.current(`\x1b[200~${inputValue}\x1b[201~`);
											} else {
												sendRef.current(inputValue);
											}
										}
										sendRef.current("\r");
										setInputValue("");
										setShowInputHistory(false);
									}}
									className="h-9 w-14 flex items-center justify-center rounded-md bg-blue-600 active:bg-blue-700 text-white"
								>
									<CornerDownLeft className="w-4 h-4" strokeWidth={1.5} />
								</button>
							</div>
						</div>
					</div>
				)}
			</div>
		);
	}),
);
