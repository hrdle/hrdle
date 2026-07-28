import { useEffect, useState } from "react";
import { storageKey } from "../utils/app-storage";

const STORAGE_KEY = storageKey("history-v2");

function readFlag(): boolean {
	try {
		// Default ON: V2 is the canonical history view. Only an explicit "false"
		// opts back into the legacy V1 list (escape hatch while V2 bakes).
		return localStorage.getItem(STORAGE_KEY) !== "false";
	} catch {
		return true;
	}
}

/**
 * Session History V2 feature flag.
 *
 * Reads `cchub-history-v2` from localStorage and returns whether the new
 * faceted/virtualized history UI should be shown. Listens for the storage
 * event so toggling the flag in another tab updates this one live.
 *
 * Default is ON; setting `cchub-history-v2` to "false" opts back into the
 * legacy V1 list during the V2 bake-in.
 */
export function useHistoryV2Flag(): boolean {
	const [enabled, setEnabled] = useState<boolean>(() => readFlag());

	useEffect(() => {
		function onStorage(e: StorageEvent) {
			if (e.key === STORAGE_KEY || e.key === null) {
				setEnabled(readFlag());
			}
		}
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	return enabled;
}
