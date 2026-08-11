/// <reference types="vite/client" />

/** The ehpk version, injected at build time from app.json — the one file that
 *  decides it. Lets a log line answer "which build is on the device?" outright
 *  instead of by comparing timestamps against when a build was promoted. */
declare const __APP_VERSION__: string

/** The server's default port, injected at build time from identity.json. The
 *  phone UI appends it to a URL typed without one, so it is what the device
 *  actually connects to — not a label. */
declare const __DEFAULT_PORT__: number

/** Short commit the bundle was built from, `+dirty` when `src/` or the shared
 *  types had uncommitted edits, `nogit` when the build had no repository to
 *  ask. The version says which number a build claims; this says which code it
 *  contains, which is the question a log line actually has to answer. */
declare const __BUILD_COMMIT__: string

/** The product's name, from identity.json. Every screen that says it says it
 *  through this — the previous rename found it written out in six of them. */
declare const __PRODUCT_NAME__: string

/** The server binary's name, from identity.json. The phone UI tells the user
 *  to run it, so it is an instruction that has to work, not a label. */
declare const __BINARY_NAME__: string

/** `owner/repo` on GitHub, from identity.json. Source of the install command
 *  and the links beside it. */
declare const __REPO__: string

/** Prefix for this app's localStorage keys, from identity.json. */
declare const __STORAGE_PREFIX__: string

/** Prefixes this app stored under before the current one. Read-only fallbacks:
 *  renaming a key does not fail, it forgets. */
