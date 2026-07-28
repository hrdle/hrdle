import {
  IDENTITY,
  LEGACY_STORAGE_PREFIXES,
} from "../../../shared/identity";

/**
 * localStorage keys, namespaced by the product's own prefix.
 *
 * Call sites name the setting (`storageKey("theme")`) rather than the key
 * (`"cchub-theme"`), so a rename is a change to identity.json instead of a
 * sweep through forty files — and so nobody has to remember that one of those
 * forty was spelled differently from the rest.
 */
export function storageKey(suffix: string): string {
  return `${IDENTITY.storagePrefix}${suffix}`;
}

/**
 * Copy anything stored under a previous prefix onto the current one.
 *
 * Copies rather than moves. During a rename the old and new builds are meant to
 * run side by side for a while, and deleting the key the old one reads would
 * sign it out and reset its settings the moment the new one started — the exact
 * failure this exists to prevent, aimed at the other build.
 *
 * A key already present under the current prefix is left alone: it is the newer
 * value, and the legacy copy is a snapshot from before the migration.
 *
 * Returns the keys it copied, which is what the tests assert on.
 */
export function migrateLegacyStorage(store: Storage = localStorage): string[] {
  const copied: string[] = [];

  // Snapshot the key list first — writing to the store while walking its live
  // index is not something the spec pins down.
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key !== null) keys.push(key);
  }

  for (const key of keys) {
    const prefix = LEGACY_STORAGE_PREFIXES.find((p) => key.startsWith(p));
    if (prefix === undefined) continue;

    const target = `${IDENTITY.storagePrefix}${key.slice(prefix.length)}`;
    if (target === key) continue;
    if (store.getItem(target) !== null) continue;

    const value = store.getItem(key);
    if (value === null) continue;

    try {
      store.setItem(target, value);
      copied.push(target);
    } catch {
      // Quota or private mode. A missed key costs a reset setting, not a
      // broken app, so the rest of the migration still runs.
    }
  }

  return copied;
}

/**
 * Run the migration when this module loads, not from an entry point.
 *
 * `main.tsx` cannot do it: ES imports are evaluated before the importing
 * module's body, so `import "./i18n"` has already run — and i18next reads the
 * stored language during its own init — by the time any statement in main.tsx
 * executes. Doing it here inverts that. Nothing can read a namespaced key
 * without importing the module that carries the old ones forward first.
 *
 * Guarded for the test runner and any other non-browser import.
 */
if (typeof localStorage !== "undefined") {
  migrateLegacyStorage();
}
