import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUlid } from "@nikovirtala/draft-core";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/main/config.ts";
import { displayName, ensureIdentity, userActor } from "../src/main/identity.ts";

describe("the local identity", () => {
  it("is created once, on the first run, and kept in config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-id-"));
    const first = ensureIdentity(dir, { gitName: () => "Ada Lovelace" });
    expect(isUlid(first.id.toUpperCase())).toBe(true);
    expect(first.name).toBe("Ada Lovelace");
    // A later run, even with another git name, keeps the same identity.
    expect(ensureIdentity(dir, { gitName: () => "Someone Else" })).toEqual(first);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).user).toEqual(first);
    expect(loadConfig(dir, {}).dataDir).toBe(dir);
  });

  it("keeps the other settings in config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-id-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ model: "claude-opus-5-5" }));
    ensureIdentity(dir, { gitName: () => "Ada" });
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toMatchObject({
      model: "claude-opus-5-5",
      user: { name: "Ada" },
    });
    expect(loadConfig(dir, {}).model).toBe("claude-opus-5-5");
  });

  it("takes its name from git, else the OS user, else a plain label", () => {
    expect(displayName({ gitName: () => "Ada", osName: () => "ada" })).toBe("Ada");
    expect(displayName({ gitName: () => null, osName: () => "ada" })).toBe("ada");
    expect(displayName({ gitName: () => null, osName: () => null })).toBe("Local user");
  });

  it("is a user actor, never an agent", () => {
    expect(userActor({ id: "01kahx0000000000000000user", name: "Ada" })).toEqual({
      kind: "user",
      id: "01kahx0000000000000000user",
      name: "Ada",
    });
  });
});
