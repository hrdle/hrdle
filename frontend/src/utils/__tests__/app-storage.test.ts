import { beforeEach, describe, expect, test } from "bun:test";
import { IDENTITY } from "../../../../shared/identity";
import { migrateLegacyStorage, storageKey } from "../app-storage";

/**
 * The migration is the only thing standing between a prefix change and every
 * user losing their settings and their session, so the cases below are the ones
 * that would cost something: a value that would be dropped, a newer value that
 * would be overwritten by an older one, and the old build's key disappearing
 * out from under it while both are running.
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const LEGACY = "cc-hub-";
const CURRENT = IDENTITY.storagePrefix;

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
});

describe("storageKey", () => {
  test("namespaces a setting under the current prefix", () => {
    expect(storageKey("theme")).toBe(`${CURRENT}theme`);
  });

  test("the auth token is no longer the odd one out", () => {
    // It was `cc-hub-token` while everything else used `cchub-`.
    expect(storageKey("token")).toBe(`${CURRENT}token`);
  });
});

describe("migrateLegacyStorage", () => {
  test("carries a legacy value onto the current prefix", () => {
    store.setItem(`${LEGACY}token`, "abc123");

    const copied = migrateLegacyStorage(store);

    expect(copied).toEqual([`${CURRENT}token`]);
    expect(store.getItem(`${CURRENT}token`)).toBe("abc123");
  });

  test("leaves the legacy key in place for a build still reading it", () => {
    // Deleting it would sign out the old build during a side-by-side rollout —
    // the exact failure this exists to prevent, aimed at the other build.
    store.setItem(`${LEGACY}token`, "abc123");

    migrateLegacyStorage(store);

    expect(store.getItem(`${LEGACY}token`)).toBe("abc123");
  });

  test("does not overwrite a value already under the current prefix", () => {
    store.setItem(`${LEGACY}token`, "old");
    store.setItem(`${CURRENT}token`, "new");

    const copied = migrateLegacyStorage(store);

    expect(copied).toEqual([]);
    expect(store.getItem(`${CURRENT}token`)).toBe("new");
  });

  test("ignores keys belonging to other apps", () => {
    store.setItem("unrelated-thing", "x");
    store.setItem("herdr-session", "y");

    expect(migrateLegacyStorage(store)).toEqual([]);
    expect(store.length).toBe(2);
  });

  test("is idempotent", () => {
    store.setItem(`${LEGACY}token`, "abc123");

    expect(migrateLegacyStorage(store)).toHaveLength(1);
    expect(migrateLegacyStorage(store)).toEqual([]);
    expect(store.getItem(`${CURRENT}token`)).toBe("abc123");
  });

  test("preserves an empty string rather than treating it as absent", () => {
    store.setItem(`${LEGACY}token`, "");

    migrateLegacyStorage(store);

    expect(store.getItem(`${CURRENT}token`)).toBe("");
  });

  test("keeps walking after one key fails to write", () => {
    let failed = false;
    const flaky = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "setItem") {
          return (key: string, value: string) => {
            if (!failed) {
              failed = true;
              throw new Error("QuotaExceededError");
            }
            target.setItem(key, value);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    store.setItem(`${LEGACY}a`, "1");
    store.setItem(`${LEGACY}b`, "2");

    const copied = migrateLegacyStorage(flaky as Storage);

    expect(copied).toEqual([`${CURRENT}b`]);
  });
});
