/** biome-ignore-all lint/correctness/useExhaustiveDependencies: depends on refs and setters that React guarantees stable; adding them would cause unintended re-runs */
import { Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { sendTerminalInput } from "../../hooks/useMultiplexedTerminal";

interface ChatComposerProps {
	sessionId: string;
	paneId: string | undefined;
	disabled?: boolean;
	placeholder?: string;
	/** Remote-control mode: send over REST instead of the mux WS (which rejects
	 *  input for sessions this client is not subscribed to). */
	sendOverRest?: (paneId: string, data: string) => Promise<boolean>;
}

export function ChatComposer({
	sessionId,
	paneId,
	disabled,
	placeholder,
	sendOverRest,
}: ChatComposerProps) {
	const [value, setValue] = useState("");
	const taRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
	}, [value]);

	const send = useCallback(() => {
		const text = value;
		if (!text.trim() || !paneId) return;
		const wrapped = text.includes("\n")
			? `\x1b[200~${text}\x1b[201~`
			: text;
		if (sendOverRest) {
			// One REST call carries text + trailing \r; clear only on success so a
			// failed request never silently drops the user's message.
			void sendOverRest(paneId, `${wrapped}\r`).then((ok) => {
				if (ok) setValue("");
			});
			return;
		}
		// During reconnect / disconnect sendTerminalInput returns false without
		// throwing. Clearing the textarea regardless would silently drop the
		// user's message. Only clear when both the text and the trailing \r
		// landed on the WS. #263
		const textOk = sendTerminalInput(sessionId, paneId, wrapped);
		const enterOk = textOk && sendTerminalInput(sessionId, paneId, "\r");
		if (textOk && enterOk) setValue("");
	}, [sessionId, paneId, value, sendOverRest]);

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
				e.preventDefault();
				send();
			}
		},
		[send],
	);

	const canSend = !disabled && !!paneId && value.trim().length > 0;

	return (
		<div
			className="shrink-0 border-t border-white/[0.06] bg-[#0a0a0a] px-3 py-2"
			style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 8px)" }}
		>
			<div className="flex items-end gap-2">
				<textarea
					ref={taRef}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder={placeholder ?? "Message..."}
					disabled={disabled || !paneId}
					rows={1}
					className="flex-1 min-h-[40px] max-h-[200px] resize-none rounded-md bg-white/[0.04] border border-white/[0.06] px-3 py-2 text-[14px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/40 disabled:opacity-50"
				/>
				<button
					type="button"
					onClick={send}
					disabled={!canSend}
					aria-label="Send"
					className={`shrink-0 h-10 px-3 rounded-md flex items-center justify-center transition-colors ${
						canSend
							? "bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white"
							: "bg-white/[0.04] text-zinc-600"
					}`}
				>
					<Send className="w-5 h-5" />
				</button>
			</div>
		</div>
	);
}
