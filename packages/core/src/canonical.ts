import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace, numbers and strings as
 * `JSON.stringify` writes them (the RFC 8785 rules for the values JSON.parse produces). `undefined`
 * object members are dropped, as JSON.stringify drops them, so a value and its JSON round trip
 * have the same canonical form.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical JSON has no non-finite numbers");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot encode a ${typeof value}`);
  }
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
