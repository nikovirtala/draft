import { conversationKey, parseAddress } from "./address.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { Projection } from "./projection.ts";

/**
 * What an agent session starts from. A session never starts from the agent's own memory: it starts
 * from this projection of the log, built by one function (`buildAgentContext`), for a restart, for
 * a switch to another agent and for a second opinion alike.
 *
 * The rule that keeps people-only messages away from the agent is enforced here, where the context
 * is assembled, not in the UI: a message is read only when its audience includes the agent, and a
 * reference is read only when the message it came from was. Nothing derived from a people-only
 * message, not even a count, enters the context.
 */

/** The briefing every new session gets before the context: what draft is and how it works. */
export const AGENT_BRIEFING = `You are the agent inside draft, a desktop app where everything folds around one conversation.
You help the user supervise Kiro cloud sessions through the Kiro Remote tools (the MCP server "kiro-remote").
- Read-only tools (list, get, wait for events, transcript, list permissions) run at once.
- Tools that change things (launch, send a prompt, answer a permission, cancel, delete) ask the user first; the user answers in the conversation. draft records each one as a step before it runs.
- You have no other tools in draft: no file or shell access.
- When you mention a Kiro session, write its full session id: draft shows every session id it finds as a live status stub.
- Keep answers short and plain.`;

export interface ContextMessage {
  role: "user" | "agent";
  at: string;
  text: string;
}

export type ContextOpenItem =
  | {
      kind: "interrupted-step";
      tool: string;
      input: unknown;
      startedAt: string;
      idempotencyKey: string;
    }
  | { kind: "call-without-permission"; tool: string; input: unknown; at: string; status: string };

export interface ContextDecision {
  at: string;
  tool: string;
  decision: "approved-by-user" | "denied-by-user" | "denied-by-policy";
  /** How an approved action ended; "interrupted" means no result was recorded. */
  outcome: "completed" | "failed" | "interrupted" | "not run";
  summary: string | null;
}

export interface ContextReference {
  target: string;
  state: Record<string, unknown>;
}

/** What a thread concluded, returned to the conversation it branched off. */
export interface ContextConclusion {
  thread: string;
  title: string;
  at: string;
  text: string;
}

export interface AgentContext {
  conversation: string;
  /** Conclusions of this conversation's threads that wrapped up, oldest first. */
  conclusions: ContextConclusion[];
  openItems: ContextOpenItem[];
  decisions: ContextDecision[];
  /** The most recent messages the agent may read, oldest first. */
  messages: ContextMessage[];
  /** Messages the agent may read that were left out to keep the context compact. */
  omittedMessages: number;
  references: ContextReference[];
}

export interface ContextLimits {
  maxMessages: number;
  maxMessageChars: number;
  maxTotalChars: number;
  maxDecisions: number;
  maxReferences: number;
}

export const DEFAULT_LIMITS: ContextLimits = {
  maxMessages: 30,
  maxMessageChars: 2000,
  maxTotalChars: 16_000,
  maxDecisions: 20,
  maxReferences: 20,
};

export interface ContextOptions {
  /** Messages to leave out, by address: the one the turn is about to send. */
  exclude?: readonly string[];
  limits?: Partial<ContextLimits>;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s;
}

/** The one function that builds what an agent session starts from. */
export function buildAgentContext(
  projection: Projection,
  conversation: string,
  o: ContextOptions = {},
): AgentContext {
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  const exclude = new Set(o.exclude ?? []);
  const all = projection.messages(conversation);
  // The audience rule. Everything below that comes from a message goes through `readable`.
  const readable = all.filter((m) => m.audience.agent && !exclude.has(m.address));
  // A reference is read only if the message it came from may be.
  const reachesAgent = new Set(all.filter((m) => m.audience.agent).map((m) => m.address));

  let chars = 0;
  const recent: ContextMessage[] = [];
  for (const m of [...readable].reverse()) {
    const text = clip(m.text, limits.maxMessageChars);
    if (recent.length >= limits.maxMessages || chars + text.length > limits.maxTotalChars) break;
    chars += text.length;
    recent.unshift({ role: m.role, at: m.at, text });
  }

  const steps = projection.steps(conversation);
  const openItems: ContextOpenItem[] = [
    ...steps
      .filter((s) => s.outcome === null && s.resolution === null)
      .map((s) => ({
        kind: "interrupted-step" as const,
        tool: s.name,
        input: s.input,
        startedAt: s.startedAt,
        idempotencyKey: s.idempotencyKey,
      })),
    ...projection.anomalies(conversation).map((a) => ({
      kind: "call-without-permission" as const,
      tool: a.name,
      input: a.input,
      at: a.at,
      status: a.status,
    })),
  ];

  const decisions: ContextDecision[] = [
    ...steps.map((s) => ({
      at: s.startedAt,
      tool: s.name,
      decision: "approved-by-user" as const,
      outcome: s.outcome ?? ("interrupted" as const),
      summary: s.resultSummary === null ? null : clip(s.resultSummary, 300),
    })),
    ...projection
      .toolCalls(conversation)
      .filter((t) => t.decision === "denied-by-user" || t.decision === "denied-by-policy")
      .map((t) => ({
        at: t.at,
        tool: t.name,
        decision: t.decision as "denied-by-user" | "denied-by-policy",
        outcome: "not run" as const,
        summary: null,
      })),
  ]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(-limits.maxDecisions);

  const seen = new Set<string>();
  const references: ContextReference[] = [];
  for (const e of projection.edges(conversation)) {
    if (!reachesAgent.has(e.from) || seen.has(e.target)) continue;
    seen.add(e.target);
    const state = projection.stub(e.target)?.state ?? e.snapshot;
    references.push({ target: e.target, state });
  }

  // A thread's conclusion returns to the conversation its branch point is in.
  const conclusions: ContextConclusion[] = [];
  for (const c of projection.conversations()) {
    if (c.parent === null) continue;
    const a = parseAddress(c.parent);
    if (conversationKey(a.context, a.conversation as string) !== conversation) continue;
    const fold = projection.thread(c.conversation);
    if (fold.state !== "wrapped-up" || fold.conclusion === null) continue;
    conclusions.push({
      thread: c.conversation,
      title: c.title,
      at: fold.conclusion.wrappedAt ?? fold.conclusion.proposedAt,
      text: clip(fold.conclusion.text, limits.maxMessageChars),
    });
  }
  conclusions.sort((x, y) => (x.at < y.at ? -1 : 1));

  return {
    conversation,
    conclusions,
    openItems,
    decisions,
    messages: recent,
    omittedMessages: readable.length - recent.length,
    references: references.slice(-limits.maxReferences),
  };
}

/** True when there is nothing worth telling a new session. */
export function isEmptyContext(c: AgentContext): boolean {
  return (
    c.openItems.length === 0 &&
    c.conclusions.length === 0 &&
    c.decisions.length === 0 &&
    c.messages.length === 0 &&
    c.references.length === 0
  );
}

/** The context as the text a new session is given first. */
export function renderAgentContext(c: AgentContext): string {
  if (isEmptyContext(c)) return "";
  const out: string[] = [
    "This is a summary from draft's log of the conversation so far, not a transcript. You are starting fresh from it: you have no memory of earlier turns.",
  ];
  if (c.openItems.length > 0) {
    out.push("\nOpen items:");
    for (const i of c.openItems) {
      out.push(
        i.kind === "interrupted-step"
          ? `- INTERRUPTED: ${i.tool} ${clip(canonicalJson(i.input), 600)}, started ${i.startedAt}. It may or may not have happened. draft will not run it again; check before you ask for it again.`
          : `- UNASKED: ${i.tool} ${clip(canonicalJson(i.input), 600)} ran (${i.status}) without asking the user first, at ${i.at}.`,
      );
    }
  }
  if (c.conclusions.length > 0) {
    out.push("\nThreads that wrapped up, with the conclusion each returned:");
    for (const k of c.conclusions) out.push(`- "${k.title}" (${k.thread}): ${k.text}`);
  }
  if (c.decisions.length > 0) {
    out.push("\nDecisions and actions so far:");
    for (const d of c.decisions) {
      const what =
        d.decision === "approved-by-user"
          ? `the user allowed ${d.tool}: ${d.outcome}${d.summary === null ? "" : ` (${d.summary})`}`
          : d.decision === "denied-by-user"
            ? `the user declined ${d.tool}`
            : `${d.tool} was refused by draft's policy`;
      out.push(`- ${d.at}: ${what}`);
    }
  }
  if (c.references.length > 0) {
    out.push("\nThings referenced in the conversation (latest known state):");
    for (const r of c.references) out.push(`- ${r.target}: ${clip(canonicalJson(r.state), 400)}`);
  }
  if (c.messages.length > 0) {
    out.push(
      `\nRecent messages, oldest first${c.omittedMessages > 0 ? ` (${c.omittedMessages} earlier ones left out)` : ""}:`,
    );
    for (const m of c.messages) out.push(`${m.role === "user" ? "User" : "You"}: ${m.text}`);
  }
  return out.join("\n");
}

/** A digest of a context, recorded when a session starts from it. */
export function contextDigest(c: AgentContext): string {
  return sha256Hex(renderAgentContext(c));
}

/**
 * How big a new session's start is, as far as draft can measure it: counts and characters of the
 * briefing and context it is given first. Tokens belong to each agent's own tokenizer, so draft
 * doesn't guess them.
 */
export interface ContextSize {
  messages: number;
  openItems: number;
  decisions: number;
  references: number;
  /** Characters of the briefing and the rendered context together. */
  characters: number;
}

export function contextSize(c: AgentContext): ContextSize {
  const rendered = renderAgentContext(c);
  return {
    messages: c.messages.length,
    openItems: c.openItems.length,
    decisions: c.decisions.length,
    references: c.references.length,
    characters: AGENT_BRIEFING.length + (rendered === "" ? 0 : rendered.length + 2),
  };
}
