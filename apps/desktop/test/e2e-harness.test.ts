import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWED } from "../e2e/console-allowlist.ts";
import { isViolation } from "../e2e/console-policy.ts";

const e2e = fileURLToPath(new URL("../e2e/", import.meta.url));
const specs = readdirSync(e2e).filter((f) => f.endsWith(".spec.ts"));
const source = (f: string) => readFileSync(join(e2e, f), "utf8");

describe("what fails an end-to-end test", () => {
  it("fails on Electron's deprecation line in the main process's stderr", () => {
    const line =
      "(electron) 'safeStorage.isEncryptionAvailable' is deprecated and will be removed. Please use 'safeStorage.isEncryptionAvailableSync' instead.";
    expect(isViolation("main stderr", line, [])).toBe(true);
  });

  it("fails on a deprecation Node prints", () => {
    const line = "(node:4242) [DEP0005] DeprecationWarning: Buffer() is deprecated";
    expect(isViolation("main stderr", line, [])).toBe(true);
  });

  it("fails on an unhandled rejection in the main process, and not on Chromium's own noise", () => {
    expect(
      isViolation("main stderr", "[UnhandledPromiseRejection: This error originated", []),
    ).toBe(true);
    expect(isViolation("main stderr", "Failed to connect to the bus: no address", [])).toBe(false);
    expect(isViolation("main stderr", "", [])).toBe(false);
  });

  it("fails on a console.error or an uncaught error in the renderer or in main", () => {
    for (const source of [
      "main console.error",
      "renderer console.error",
      "renderer uncaught error",
    ] as const)
      expect(isViolation(source, "boom", [])).toBe(true);
  });

  it("lets through a line an allow-list entry matches, and only that line", () => {
    const allowed = [{ pattern: /^known noise$/, why: "a test" }];
    expect(isViolation("renderer console.error", "known noise", allowed)).toBe(false);
    expect(isViolation("renderer console.error", "other noise", allowed)).toBe(true);
  });

  it("says why for every entry of the allow-list", () => {
    for (const entry of ALLOWED) expect(entry.why.trim().length).toBeGreaterThan(20);
  });
});

describe("the end-to-end specs", () => {
  it.each(specs)("%s uses the harness to launch the app and to take screenshots", (file) => {
    const text = source(file);
    expect(text, "launch with launchApp from ./harness.ts").not.toMatch(
      /_electron|electron\.launch/,
    );
    expect(text, "import test from ./harness.ts").not.toMatch(
      /\btest,?\s[^;]*from "@playwright\/test"/,
    );
    expect(text).toContain('from "./harness.ts"');
  });
});
