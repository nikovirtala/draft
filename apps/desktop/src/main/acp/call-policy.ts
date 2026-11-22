import type { AgentKind } from "./agents.ts";

/**
 * How long draft's MCP server keeps an agent's call open while the person decides, and what it
 * does when that time is up. One place, so the timing and the words the agent is told never
 * drift apart (adr:56v0mtga refined by the ADR on late answers).
 *
 * An agent's MCP client gives up on a request after its own timeout: Kiro's `requestTimeout` is
 * 120 000 ms by default (https://kiro.dev/docs/custom-agents/configuration-reference/), and the
 * MCP TypeScript SDK's is 60 000 ms (https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#timeouts,
 * "SHOULD establish timeouts for all sent requests"). draft can't raise either for a server that
 * `session/new` supplies, and no documented client resets its timeout on progress, so draft
 * answers before the client gives up: the call stays pending on draft's side, the agent is told to
 * call again with the same arguments, and the repeated call picks the call up.
 */
export interface CallPolicy {
  /** How long one request is held open before it is answered with "still deciding". */
  holdMs: number;
  /**
   * How long a call stays pending, from its first request: past that, a decision that comes late
   * is not acted on and a result nobody collected is dropped. A turn's end settles it sooner.
   */
  retainMs: number;
  /**
   * How long after a request collected a call's result a cancellation of that request still gives
   * the result back. A client that times out sends `notifications/cancelled` a moment after, and
   * the result may already have been written to a request it no longer listens to.
   */
  cancelGraceMs: number;
}

/** What the client's timeout is, less a margin for the time the request spent getting here. */
const KIRO_REQUEST_TIMEOUT_MS = 120_000;
const SHORTEST_KNOWN_REQUEST_TIMEOUT_MS = 60_000;
const MARGIN_MS = 15_000;
const RETAIN_MS = 30 * 60_000;
const CANCEL_GRACE_MS = 10_000;

export function callPolicy(kind: AgentKind): CallPolicy {
  const timeout = kind === "kiro" ? KIRO_REQUEST_TIMEOUT_MS : SHORTEST_KNOWN_REQUEST_TIMEOUT_MS;
  return { holdMs: timeout - MARGIN_MS, retainMs: RETAIN_MS, cancelGraceMs: CANCEL_GRACE_MS };
}

/** What a call is waiting for when its request is answered without a result. */
export type CallPhase = "deciding" | "running";

/**
 * What the agent is told when its request is held no longer. Not an error: nothing failed, and
 * nothing was refused or run yet. The same words go to every agent.
 */
export function stillWaitingText(tool: string, phase: CallPhase): string {
  const state =
    phase === "deciding"
      ? "The user has not answered yet, so draft has neither run this call nor refused it."
      : "The call is still running.";
  return `${state} This is not a failure. Call ${tool} again with exactly the same arguments to keep waiting: draft asks the user only once and runs the call only once, and the repeated call returns its result.`;
}

/** What the agent is told when a decision or a result came too late to be used. */
export const TOO_LATE_TEXT =
  "The user answered after the agent stopped asking about this call, so draft did not run it.";
