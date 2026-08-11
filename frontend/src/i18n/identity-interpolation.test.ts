import { describe, expect, test } from "bun:test";
import i18next from "i18next";
import { IDENTITY } from "../../../shared/identity";
import "./index";

/**
 * The catalogs name the product through `{{product}}` and `{{bin}}`, filled by
 * i18next's `defaultVariables` rather than by each call site.
 *
 * Nothing about that is visible where the strings are used, so if the config
 * ever loses `defaultVariables` the placeholders reach the user verbatim —
 * including the hook setup prompt, which is handed to an agent that then edits
 * a settings file from it.
 */

describe("identity interpolation", () => {
  test("the app's own i18n config fills product and bin", () => {
    // Not a hand-built instance: this is the module the app imports, so the
    // test fails if the real init drops defaultVariables.
    expect(i18next.t("onboarding.welcomePrompt")).toContain(
      IDENTITY.productName,
    );
    expect(i18next.t("onboarding.welcomePrompt")).not.toContain("{{");
  });

  test("a caller-supplied value still wins", () => {
    const rendered = i18next.t("onboarding.hookSetupPrompt", {
      command: "/somewhere/else notify",
    });
    expect(rendered).toContain("/somewhere/else notify");
    expect(rendered).not.toContain("{{");
  });

  test("no catalog string is left holding an identity placeholder", async () => {
    // Only the two that defaultVariables is responsible for. Everything else —
    // {{command}}, {{seconds}}, {{count}} — is the call site's to supply, and a
    // bare t() is expected to leave those standing.
    const IDENTITY_SLOTS = /\{\{(product|bin)\}\}/;
    const offenders: string[] = [];

    for (const lang of ["en", "ja"]) {
      const catalog = (await import(`./locales/${lang}.json`)).default;
      const walk = (node: unknown, path: string[]): void => {
        if (typeof node === "string") {
          const key = path.join(".");
          if (IDENTITY_SLOTS.test(i18next.t(key, { lng: lang }))) {
            offenders.push(`${lang}:${key}`);
          }
          return;
        }
        if (node && typeof node === "object") {
          for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
        }
      };
      walk(catalog, []);
    }

    expect(offenders).toEqual([]);
  });
});
