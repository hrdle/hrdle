import { useCallback, useEffect, useState } from "react";
import { storageKey } from "../utils/app-storage";

/**
 * What the person chose, not what the mode currently is: `"true"` means they
 * asked for the terminal to be rendered here.
 *
 * A key of its own because the previous one (`hrdle-remote-control`) cannot
 * express "unset" — it was written on mount, so every desktop that had ever
 * loaded the app held an explicit `"false"` nobody had chosen, and the default
 * could never be changed again. Only a deliberate toggle writes this one.
 */
const STORAGE_KEY = storageKey("desktop-terminal");

function readFlag(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) !== "true";
	} catch {
		return true;
	}
}

/**
 * Remote-control mode flag (PC/desktop only).
 *
 * When enabled, Hrdle stops the live terminal render (WS `subscribe` →
 * PaneController) so it never takes over the pane — the running local herdr
 * client keeps ownership of the terminal. Everything else (workspace/pane list,
 * focus, split/close, new session, tab ops, prompt, Files, Dashboard, Chat)
 * still works because those paths don't need a control stream.
 *
 * **Default ON.** On a desktop the terminal is already on screen in herdr, and
 * a second copy of it painted over a WebSocket is the slowest thing Hrdle does
 * for the least it buys. What the desktop is for is the part herdr has no
 * answer to: the session list, history, the dashboard, starting a session.
 * A phone or tablet has no local herdr, so this stays off there — the gate is
 * in DesktopLayout (`!isTablet && flag`), not here.
 *
 * The toggle stays, because a desktop browser away from the herdr host still
 * needs a terminal.
 *
 * Listens for the storage event so toggling in another tab updates this one
 * live, following `useHistoryV2Flag`.
 */
export function useRemoteControlMode(): {
	remoteControl: boolean;
	toggleRemoteControl: () => void;
	setRemoteControl: (value: boolean) => void;
} {
	const [remoteControl, setRemoteControlState] = useState<boolean>(() =>
		readFlag(),
	);

	const setRemoteControl = useCallback((value: boolean) => {
		setRemoteControlState(value);
		try {
			localStorage.setItem(STORAGE_KEY, value ? "false" : "true");
		} catch {
			// ignore
		}
	}, []);

	useEffect(() => {
		function onStorage(e: StorageEvent) {
			if (e.key === STORAGE_KEY || e.key === null) {
				setRemoteControlState(readFlag());
			}
		}
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	const toggleRemoteControl = useCallback(() => {
		setRemoteControlState((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(STORAGE_KEY, next ? "false" : "true");
			} catch {
				// ignore
			}
			return next;
		});
	}, []);

	return { remoteControl, toggleRemoteControl, setRemoteControl };
}
