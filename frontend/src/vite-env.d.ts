/// <reference types="vite/client" />

declare module "*.css";

/** Release version from the root package.json, injected by vite at build time. */
declare const __APP_VERSION__: string;

interface Window {
	__cchub_ws_bytes_per_sec?: number;
}
