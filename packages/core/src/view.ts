import { z } from "zod";

/**
 * The fixed component set, described as JSON. The agent fills these components; it never invents
 * layout. A description that fails these schemas is shown as plain text and counted, because
 * repeated failures are the signal that the set is missing a component (raw HTML comes later).
 */

export const TextComponentSchema = z.object({
  component: z.literal("text"),
  text: z.string(),
});

export const StatusStubComponentSchema = z.object({
  component: z.literal("status-stub"),
  target: z.object({ type: z.literal("kiro-session"), id: z.string().min(1) }),
});

export const ViewDescriptionSchema = z.discriminatedUnion("component", [
  TextComponentSchema,
  StatusStubComponentSchema,
]);
export type ViewDescription = z.infer<typeof ViewDescriptionSchema>;

export type ViewCheck =
  | { ok: true; view: ViewDescription }
  | { ok: false; reason: string; fallback: string };

/** Checks a description given as JSON text or as a value. */
export function checkView(input: unknown): ViewCheck {
  let value = input;
  const fallback = typeof input === "string" ? input : safeStringify(input);
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, reason: "not JSON", fallback };
    }
  }
  const r = ViewDescriptionSchema.safeParse(value);
  if (!r.success)
    return { ok: false, reason: r.error.issues.map((i) => i.message).join("; "), fallback };
  return { ok: true, view: r.data };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** One block of a message: plain text, or a fenced ```view block holding a JSON description. */
export type MessageSegment = { kind: "text"; text: string } | { kind: "view"; source: string };

const FENCE_RE = /```view[ \t]*\n([\s\S]*?)\n```/g;

/** Splits message text into text and view-description segments, in order. */
export function segmentMessage(text: string): MessageSegment[] {
  const out: MessageSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE_RE)) {
    const before = text.slice(last, m.index).trim();
    if (before !== "") out.push({ kind: "text", text: before });
    out.push({ kind: "view", source: m[1] as string });
    last = (m.index ?? 0) + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest !== "" || out.length === 0) out.push({ kind: "text", text: rest });
  return out;
}
