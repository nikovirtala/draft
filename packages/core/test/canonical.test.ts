import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.ts";

/**
 * canonicalJson against RFC 8785, the JSON Canonicalization Scheme: the samples from the RFC's
 * text and Appendix B, and the reference implementation's test files.
 */

const fromIeee754 = (hex: string): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

describe("RFC 8785 number serialization (Appendix B)", () => {
  it.each([
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ])("%s serializes as %s", (hex, expected) => {
    expect(canonicalJson(fromIeee754(hex))).toBe(expected);
  });

  it.each([
    ["7fffffffffffffff", "NaN"],
    ["7ff0000000000000", "Infinity"],
    ["fff0000000000000", "-Infinity"],
  ])("%s (%s) is refused", (hex) => {
    expect(() => canonicalJson(fromIeee754(hex))).toThrow(TypeError);
  });
});

describe("RFC 8785 primitives and property sorting (sections 3.2.2 and 3.2.3)", () => {
  it("serializes the section 3.2.2 sample", () => {
    const parsed = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals": [null, true, false]}',
    );
    expect(canonicalJson(parsed)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts properties by UTF-16 code units, non-ASCII keys included", () => {
    const parsed = JSON.parse(
      '{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh",' +
        '"1": "One", "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control",' +
        '"\\u00f6": "Latin Small Letter O With Diaeresis"}',
    );
    // Read the order from the text: JSON.parse would put the integer-like key "1" first again.
    const order = [...canonicalJson(parsed).matchAll(/:"([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ]);
  });

  it("escapes strings as JSON.stringify does: short escapes, lowercase \\u00xx, no escaped slash", () => {
    expect(canonicalJson('\b\f\n\r\t"\\/\u0000\u001f\u007f')).toBe(
      '"\\b\\f\\n\\r\\t\\"\\\\/\\u0000\\u001f\u007f"',
    );
    expect(canonicalJson("é€😀")).toBe('"é€😀"');
  });
});

describe("the RFC 8785 reference test files", () => {
  const dir = join(import.meta.dirname, "rfc8785");
  const names = readdirSync(join(dir, "input")).filter((n) => n.endsWith(".json"));

  it("has all six", () => {
    expect(names.sort()).toEqual([
      "arrays.json",
      "french.json",
      "structures.json",
      "unicode.json",
      "values.json",
      "weird.json",
    ]);
  });

  it.each(names)("%s canonicalizes to the expected bytes", (name) => {
    const input = JSON.parse(readFileSync(join(dir, "input", name), "utf8"));
    const expected = readFileSync(join(dir, "output", name), "utf8").replace(/\n$/, "");
    expect(canonicalJson(input)).toBe(expected);
  });
});
