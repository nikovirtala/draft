import { type Address, tryParseAddress } from "./address.ts";
import { sha256Hex } from "./canonical.ts";
import { isUnknown, type LogRecord, targetKey } from "./events.ts";

/**
 * References across contexts (ADR gw4vxvw4). The address of an item in another context, written in
 * a message, becomes a reference whose target type is `context-item` and whose snapshot is taken
 * once, from the other context's log, by draft and not by a model. The agent of the referencing
 * context never reads that log, and the snapshot reaches it only if a person pulls it in.
 */

/** The reference type of an item that lives in another context. */
export const CONTEXT_ITEM = "context-item";

/** The key of a context item among a conversation's reference targets. */
export function contextItemKey(address: string): string {
  return targetKey({ type: CONTEXT_ITEM, id: address });
}

export function isContextItemKey(target: string): boolean {
  return target.startsWith(`${CONTEXT_ITEM}:`);
}

/** What was kept of another context's item when it was referenced. */
export interface ContextItemSnapshot {
  /** The other context, by the name this device knows it by. */
  context: string;
  /** The item's address as the person wrote it, with the other context's device name. */
  address: string;
  kind: "message" | "conversation";
  version: number;
  /** The hash of the event the snapshot was taken from: it names exactly what was seen. */
  hash: string;
  /** The first line of the item, or the conversation's title. */
  title: string;
  /** A bounded excerpt of a message; `null` for a conversation. */
  text: string | null;
  role: "user" | "agent" | null;
  /** When the item was written, in its own log. */
  at: string;
}

const SEG = "[0-9a-z](?:[0-9a-z-]{0,62}[0-9a-z])?";
const IN_TEXT = new RegExp(
  `(?<![\\w@/.:-])(${SEG})/(${SEG})(?:/(${SEG}))?@([1-9][0-9]{0,8})(?![\\w@/-])`,
  "g",
);

/**
 * The versioned addresses in some text that name a conversation or an item, in order, without
 * repeats. Whether the first part is a context on this device is for the caller to decide.
 */
export function findContextAddresses(text: string): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const m of text.matchAll(IN_TEXT)) {
    const a = tryParseAddress(m[0]);
    if (a === null || a.version === null) continue;
    const key = m[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

const TITLE_MAX = 120;
const TEXT_MAX = 300;

function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const t = line.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The snapshot of an item, read from the records of another context's log. `name` is what this
 * device calls that context and `logContext` what the log's own addresses say (they differ only
 * for an imported log, ADR 17gtag9n). Null when the log has no such item at that version.
 */
export function snapshotFromRecords(
  records: readonly LogRecord[],
  a: Address,
  names: { name: string; logContext: string },
): ContextItemSnapshot | null {
  if (a.conversation === null || a.version === null) return null;
  const inLog = `${names.logContext}/${a.conversation}${a.item === null ? "" : `/${a.item}`}@${a.version}`;
  const written = `${names.name}/${a.conversation}${a.item === null ? "" : `/${a.item}`}@${a.version}`;
  for (const r of records) {
    if (isUnknown(r)) continue;
    if (a.item !== null) {
      if (r.type !== "message.posted" || r.address !== inLog) continue;
      return {
        context: names.name,
        address: written,
        kind: "message",
        version: a.version,
        hash: r.hash,
        title: firstLine(r.data.text, TITLE_MAX),
        text: r.data.text.length > TEXT_MAX ? `${r.data.text.slice(0, TEXT_MAX)}…` : r.data.text,
        role: r.data.role,
        at: r.at,
      };
    }
    if (r.type !== "conversation.created" || r.address !== inLog) continue;
    return {
      context: names.name,
      address: written,
      kind: "conversation",
      version: a.version,
      hash: r.hash,
      title: r.data.title,
      text: null,
      role: null,
      at: r.at,
    };
  }
  return null;
}

/** A digest that names a snapshot, for logs that only keep the hash of what was seen. */
export function snapshotDigest(s: ContextItemSnapshot): string {
  return sha256Hex(`${s.context}|${s.address}|${s.hash}`);
}
