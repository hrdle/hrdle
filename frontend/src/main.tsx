import { createRoot } from "react-dom/client";
import { App } from "./App";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { initRemoteLogger } from "./utils/remoteLogger";
import { applyUiScale, getStoredUiScale } from "./utils/uiScale";
import { dispatchNotificationNavigation } from "./utils/notificationNavigation";
import { ensurePushSubscription } from "./utils/webPush";
import "./i18n";
import "./index.css";

// Apply persisted UI scale before render to avoid flash of unstyled content
applyUiScale(getStoredUiScale());

// Initialize remote logging first
initRemoteLogger();

// Log app version and device info for debugging
console.log(
	`[CC Hub] App loaded v${__APP_VERSION__} - ${new Date().toISOString()}`,
);
console.log(`[CC Hub] UA: ${navigator.userAgent}`);
console.log(
	`[CC Hub] Screen: ${screen.width}x${screen.height} DPR:${devicePixelRatio}`,
);
console.log(`[CC Hub] Viewport: ${window.innerWidth}x${window.innerHeight}`);
console.log(
	`[CC Hub] WebGL: ${(() => {
		try {
			const c = document.createElement("canvas");
			return !!(c.getContext("webgl2") || c.getContext("webgl"));
		} catch {
			return false;
		}
	})()}`,
);
console.log(
	`[CC Hub] SW: ${"serviceWorker" in navigator ? "supported" : "unsupported"}`,
);

// Handle visual viewport changes (soft keyboard)
const updateViewportHeight = () => {
	const vh = window.visualViewport?.height ?? window.innerHeight;
	document.documentElement.style.setProperty("--vh", `${vh}px`);
};

updateViewportHeight();
window.visualViewport?.addEventListener("resize", updateViewportHeight);
window.addEventListener("resize", updateViewportHeight);

// Request notification permission for hook event notifications
if ("Notification" in window && Notification.permission === "default") {
	Notification.requestPermission().then(() => void ensurePushSubscription());
}

// Register this browser for Web Push on every load. A hook event fired while
// the tab is frozen — which on Android is most of the time the screen is off —
// reaches the phone through the operating system rather than through a socket
// that is no longer open. Idempotent, and silent when the browser cannot do it.
void ensurePushSubscription();

// Listen for ServiceWorker log messages
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data?.type === "sw-log") {
			console.log(event.data.message);
		}
		if (
			event.data?.type === "notification-click" &&
			typeof event.data.sessionId === "string"
		) {
			dispatchNotificationNavigation({
				sessionId: event.data.sessionId,
				peerId:
					typeof event.data.peerId === "string"
						? event.data.peerId
						: undefined,
			});
		}
	});
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");
const root = createRoot(rootEl);
root.render(
	<>
		<App />
		<UpdatePrompt />
	</>,
);
