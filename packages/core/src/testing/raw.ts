import { eventHash } from "../events.ts";

/**
 * Seals a raw record onto a chain, the way another (newer) build of draft would write an event
 * this one doesn't know. For tests only: draft itself only ever writes events it understands.
 */
export function sealRawRecord(
  fields: Record<string, unknown>,
  prevHash: string,
): Record<string, unknown> {
  const record = { ...fields, prevHash };
  return { ...record, hash: eventHash(record) };
}

/** Appends raw records to the text of a JSON Lines log, chained to its last line. */
export function appendRawLines(text: string, records: readonly Record<string, unknown>[]): string {
  const lines = text.split("\n").filter((l) => l !== "");
  let prev =
    lines.length === 0 ? "0".repeat(64) : (JSON.parse(lines.at(-1) as string).hash as string);
  for (const r of records) {
    const sealed = sealRawRecord(r, prev);
    lines.push(JSON.stringify(sealed));
    prev = sealed.hash as string;
  }
  return `${lines.join("\n")}\n`;
}
