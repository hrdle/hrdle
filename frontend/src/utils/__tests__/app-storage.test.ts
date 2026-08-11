import { describe, expect, test } from "bun:test";
import { IDENTITY } from "../../../../shared/identity";
import { storageKey } from "../app-storage";

const CURRENT = IDENTITY.storagePrefix;

describe("storageKey", () => {
  test("namespaces a setting under the current prefix", () => {
    expect(storageKey("theme")).toBe(`${CURRENT}theme`);
  });

  test("every setting takes the same prefix, with no odd one out", () => {
    expect(storageKey("token")).toBe(`${CURRENT}token`);
    expect(storageKey("last-session-id")).toBe(`${CURRENT}last-session-id`);
  });
});
