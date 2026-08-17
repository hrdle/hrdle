// Storage keys.
//
// On the device the store is the host app's, reached over the Even Hub bridge;
// in the browser simulator it is plain `localStorage`. Both are read the same
// way, which is why `get` is passed in rather than assumed.

/** The key this app writes for `suffix`. */
export function storageKey(suffix: string): string {
  return `${__STORAGE_PREFIX__}${suffix}`
}

/** Read `suffix` from a store. */
export async function readStored(
  get: (key: string) => string | null | undefined | Promise<string | null | undefined>,
  suffix: string,
): Promise<string | null> {
  const value = await get(storageKey(suffix))
  return value || null
}

/** Clear `suffix`. */
export async function clearStored(
  set: (key: string, value: string) => unknown | Promise<unknown>,
  suffix: string,
): Promise<void> {
  await set(storageKey(suffix), '')
}

/** `readStored` for a synchronous store — the simulator's `localStorage`. */
export function readStoredSync(suffix: string): string | null {
  try {
    return localStorage.getItem(storageKey(suffix)) || null
  } catch {
    // Private mode. No store to read.
    return null
  }
}

/** Write `suffix` to the simulator's `localStorage`. */
export function writeStoredSync(suffix: string, value: string): void {
  try {
    localStorage.setItem(storageKey(suffix), value)
  } catch {
    /* private mode */
  }
}

/** `clearStored` for the simulator's `localStorage`. */
export function clearStoredSync(suffix: string): void {
  try {
    localStorage.removeItem(storageKey(suffix))
  } catch {
    /* private mode */
  }
}
