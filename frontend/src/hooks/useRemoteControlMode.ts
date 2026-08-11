import { useCallback, useEffect, useState } from "react";
import { storageKey } from "../utils/app-storage";

const STORAGE_KEY = storageKey("remote-control");

function readFlag(): boolean {
	try {
		// Default OFF: remote-control mode is opt-in. Only an explicit "true"
		// enables it (PC-only "let the local herdr client own the terminal" mode).
		return localStorage.getItem(STORAGE_KEY) === "true";
	} catch {
		return false;
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
 * Persisted in `hrdle-remote-control` (default OFF). Listens for the storage
 * event so toggling in another tab updates this one live. Mirrors the
 * `useTheme` (getter init + `setItem` on change) / `useHistoryV2Flag`
 * (storage-event sync) conventions.
 */
export function useRemoteControlMode(): {
	remoteControl: boolean;
	toggleRemoteControl: () => void;
	setRemoteControl: (value: boolean) => void;
} {
	const [remoteControl, setRemoteControl] = useState<boolean>(() => readFlag());

	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, remoteControl ? "true" : "false");
		} catch {
			// ignore
		}
	}, [remoteControl]);

	useEffect(() => {
		function onStorage(e: StorageEvent) {
			if (e.key === STORAGE_KEY || e.key === null) {
				setRemoteControl(readFlag());
			}
		}
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	const toggleRemoteControl = useCallback(() => {
		setRemoteControl((prev) => !prev);
	}, []);

	return { remoteControl, toggleRemoteControl, setRemoteControl };
}
