/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module "*.css";

/** Release version from the root package.json, injected by vite at build time. */
declare const __APP_VERSION__: string;

interface Window {
	__hrdle_ws_bytes_per_sec?: number;
}
