import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AddressError,
  formatAddress,
  itemAddress,
  parseAddress,
  unversioned,
} from "../src/address.ts";

describe("addresses", () => {
  it("parses a full item address", () => {
    expect(parseAddress("local/01jx5v7c9m/01jx5v7d2k@3")).toEqual({
      context: "local",
      conversation: "01jx5v7c9m",
      item: "01jx5v7d2k",
      version: 3,
    });
  });

  it("parses contexts and conversations, which are items too", () => {
    expect(parseAddress("local@1")).toEqual({
      context: "local",
      conversation: null,
      item: null,
      version: 1,
    });
    expect(parseAddress("work/design-doc@2")).toEqual({
      context: "work",
      conversation: "design-doc",
      item: null,
      version: 2,
    });
  });

  it("treats a missing version as the latest", () => {
    expect(parseAddress("local/c1/i1").version).toBeNull();
  });

  it.each([
    "",
    "Local/c/i@1",
    "local/c/i@0",
    "local/c/i@01",
    "local/c/i@-1",
    "local//i@1",
    "local/c/i/extra@1",
    "-local/c@1",
    "local-/c@1",
    "local/c/i@1@2",
    "local/c/i @1",
    "local/c/ü@1",
    `${"a".repeat(65)}@1`,
  ])("rejects %j", (input) => {
    expect(() => parseAddress(input)).toThrow(AddressError);
  });

  it("formats what it parses", () => {
    const segment = fc.stringMatching(/^[0-9a-z](?:[0-9a-z-]{0,10}[0-9a-z])?$/);
    fc.assert(
      fc.property(
        segment,
        fc.option(fc.tuple(segment, fc.option(segment, { nil: null })), { nil: null }),
        fc.option(fc.integer({ min: 1, max: 999_999 }), { nil: null }),
        (context, rest, version) => {
          const a = {
            context,
            conversation: rest?.[0] ?? null,
            item: rest?.[1] ?? null,
            version,
          };
          expect(parseAddress(formatAddress(a))).toEqual(a);
        },
      ),
    );
  });

  it("builds item addresses inside a conversation", () => {
    expect(itemAddress("local/c1", "i1")).toBe("local/c1/i1@1");
    expect(itemAddress("local/c1", "i1", 4)).toBe("local/c1/i1@4");
    expect(() => itemAddress("local", "i1")).toThrow(AddressError);
    expect(unversioned("local/c1/i1@4")).toBe("local/c1/i1");
  });
});
