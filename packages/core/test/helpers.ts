import { type Audience, type EventDraft, PEOPLE_AND_AGENT } from "../src/events.ts";
import { createUlidFactory } from "../src/ids.ts";

/** A deterministic clock and id source for tests. */
export function testClock(start = Date.UTC(2026, 10, 20, 12, 0, 0)) {
  let t = start;
  const now = () => t;
  return {
    now,
    advance: (ms: number) => {
      t += ms;
    },
    newId: createUlidFactory({ now, random: (n) => new Uint8Array(n).fill(7) }),
  };
}

export const USER = { kind: "user", id: "01kahx0000000000000000user", name: "Test User" } as const;
export const AGENT = {
  kind: "agent",
  id: "draft-agent",
  model: "claude-opus-5-5",
  version: "0.3.329",
} as const;
export const SYSTEM = { kind: "system", id: "draft", version: "0.0.0" } as const;
export const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

export const CONV = "local/c1";

export function genesisDrafts(): EventDraft[] {
  return [
    {
      type: "context.created",
      address: "local@1",
      conversation: null,
      actor: SYSTEM,
      traceId: null,
      data: { context: "local", title: "Local" },
    },
    {
      type: "conversation.created",
      address: `${CONV}@1`,
      conversation: CONV,
      actor: SYSTEM,
      traceId: null,
      data: { conversation: CONV, title: "Conversation", parent: null },
    },
  ];
}

export function messageDraft(
  item: string,
  role: "user" | "agent",
  text: string,
  audience: Audience = PEOPLE_AND_AGENT,
): EventDraft {
  return {
    type: "message.posted",
    address: `${CONV}/${item}@1`,
    conversation: CONV,
    actor: role === "user" ? USER : AGENT,
    traceId: TRACE,
    data: { role, text, audience },
  };
}
