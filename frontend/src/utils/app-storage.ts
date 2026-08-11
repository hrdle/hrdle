import { IDENTITY } from "../../../shared/identity";

/**
 * localStorage keys, namespaced by the product's own prefix.
 *
 * Call sites name the setting (`storageKey("theme")`) rather than the key
 * (`"hrdle-theme"`), so a rename is a change to identity.json instead of a
 * sweep through forty files — and so nobody has to remember that one of those
 * forty was spelled differently from the rest.
 */
export function storageKey(suffix: string): string {
  return `${IDENTITY.storagePrefix}${suffix}`;
}
