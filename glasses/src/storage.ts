// Storage keys, and the keys this app used to write.
//
// Renaming a key does not fail, it forgets: the hub URL goes blank and the app
// shows the setup guide to someone who already set it up, the simulator loses
// its backdrop, the resume point is gone. So the old names stay readable and
// only the new one is written — the same bargain `LEGACY_STORAGE_PREFIXES` in
// shared/identity.ts makes for the web UI, spelled separately here because
// glasses/src deliberately keeps no dependency on shared/.
//
// On the device this is nearly always a miss: `com.hrdle.glasses` is a new
// project to the Hub, so it starts with an empty store and the wearer types
// the URL once. It is the browser simulator, served from the same origin as
// ever, that actually carries settings across the rename.

/** The key this app writes for `suffix`. */
export function storageKey(suffix: string): string {
  return `${__STORAGE_PREFIX__}${suffix}`
}

/** Keys this app wrote for `suffix` before the current prefix. Read-only. */
export function legacyStorageKeys(suffix: string): string[] {
  return __LEGACY_STORAGE_PREFIXES__.map((prefix) => `${prefix}${suffix}`)
}

/**
 * Read `suffix` from a store, falling back to the keys this app used to write.
 *
 * `get` is passed in rather than assumed: on the device the store is the host
 * app's, reached over the Even Hub bridge, and in the simulator it is plain
 * `localStorage`. Both are read the same way.
 */
export async function readStored(
  get: (key: string) => string | null | undefined | Promise<string | null | undefined>,
  suffix: string,
): Promise<string | null> {
  for (const key of [storageKey(suffix), ...legacyStorageKeys(suffix)]) {
    const value = await get(key)
    if (value) return value
  }
  return null
}

/**
 * Clear `suffix` everywhere this app has ever written it.
 *
 * The fallback above is what makes this necessary: clearing only the current
 * key leaves an old one behind for `readStored` to find, and a disconnect would
 * reconnect to the same server on the next launch.
 */
export async function clearStored(
  set: (key: string, value: string) => unknown | Promise<unknown>,
  suffix: string,
): Promise<void> {
  for (const key of [storageKey(suffix), ...legacyStorageKeys(suffix)]) {
    await set(key, '')
  }
}

/** `readStored` for a synchronous store — the simulator's `localStorage`. */
export function readStoredSync(suffix: string): string | null {
  for (const key of [storageKey(suffix), ...legacyStorageKeys(suffix)]) {
    try {
      const value = localStorage.getItem(key)
      if (value) return value
    } catch {
      // Private mode. No store to read, and none to fall back to.
      return null
    }
  }
  return null
}

/** Write `suffix` to the simulator's `localStorage` under the current key. */
export function writeStoredSync(suffix: string, value: string): void {
  try {
    localStorage.setItem(storageKey(suffix), value)
  } catch {
    /* private mode */
  }
}

/** `clearStored` for the simulator's `localStorage` — old keys included, or
 *  "reset to default" would restore whatever the old key still holds. */
export function clearStoredSync(suffix: string): void {
  for (const key of [storageKey(suffix), ...legacyStorageKeys(suffix)]) {
    try {
      localStorage.removeItem(key)
    } catch {
      return
    }
  }
}
