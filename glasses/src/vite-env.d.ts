/// <reference types="vite/client" />

/** The ehpk version, injected at build time from app.json — the one file that
 *  decides it. Lets a log line answer "which build is on the device?" outright
 *  instead of by comparing timestamps against when a build was promoted. */
declare const __APP_VERSION__: string
