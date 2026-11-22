import {
  type Actor,
  type EventDataOf,
  type EventDraft,
  type EventType,
  PEOPLE_AND_AGENT,
} from "../events.ts";
import type { LogStore } from "../log.ts";

/**
 * A recorded log for the map: a context with a main conversation, three threads, steps in each
 * state, interrupts of three kinds, acceptance requests in four states, a Kiro session and two pull
 * requests. The times are fixed, a minute or so apart, so tests can ask for a window or a position.
 *
 * `appendMapFixture` writes it through a log, so unit tests use a memory log and the end-to-end run
 * a file log in a context's directory.
 */

export const MAP_CONTEXT = "local";
export const MAP_MAIN = "local/c1";
export const MAP_THREAD_CONCLUDING = "local/t1";
export const MAP_THREAD_OPEN = "local/t2";
export const MAP_THREAD_WITHDRAWN = "local/t3";
export const MAP_SESSION = "01KAHX7Z1M2N3P4Q5R6S7T8V9W";
export const MAP_PR_MERGED = "nikovirtala/draft/pull/1";
export const MAP_PR_READY = "nikovirtala/draft/pull/2";
export const MAP_PR_FAILING = "nikovirtala/draft/pull/3";

const SYSTEM: Actor = { kind: "system", id: "draft", version: "0.0.0" };
const USER: Actor = { kind: "user", id: "01kahx0000000000000000user", name: "Test User" };
const AGENT: Actor = { kind: "agent", id: "draft-agent", model: "claude-opus-5-5", version: "1" };
const RESOLVER: Actor = { kind: "resolver", id: "github", version: "1" };

/** The time of minute `m` (and second `s`) of the fixture. */
export function at(m: number, s = 0): string {
  return new Date(Date.UTC(2026, 10, 20, 12, m, s)).toISOString();
}

/** A pull request's state as the resolver reports it, with what a test varies. */
export function pullRequestState(
  n: number,
  o: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    repo: "nikovirtala/draft",
    number: n,
    title: `Change ${n}`,
    url: `https://github.com/nikovirtala/draft/pull/${n}`,
    state: "open",
    draft: false,
    author: "niko",
    headSha: `${n}`.repeat(40).slice(0, 40),
    headRef: `branch-${n}`,
    headRepo: null,
    baseRef: "main",
    mergeable: true,
    mergeableState: "clean",
    checks: [
      { name: "ci", source: "check-run", status: "completed", conclusion: "success", url: null },
    ],
    checksSummary: { total: 1, passed: 1, failed: 0, pending: 0 },
    review: { decision: "none", reviews: [], requested: [] },
    viewerReviewRequested: false,
    updatedAt: at(0),
    ...o,
  };
}

export async function appendMapFixture(log: LogStore): Promise<void> {
  const out: EventDraft[] = [];
  const add = <T extends EventType>(
    type: T,
    when: string,
    conversation: string | null,
    item: string | null,
    actor: Actor,
    data: EventDataOf<T>,
  ): string => {
    const address =
      item === null
        ? conversation === null
          ? `${MAP_CONTEXT}@1`
          : `${conversation}@1`
        : `${conversation}/${item}@1`;
    out.push({ type, address, conversation, actor, traceId: null, data, at: when } as EventDraft);
    return address;
  };
  const key = (k: string) => k;

  add("context.created", at(0), null, null, SYSTEM, { context: MAP_CONTEXT, title: "Local" });
  add("conversation.created", at(0), MAP_MAIN, null, SYSTEM, {
    conversation: MAP_MAIN,
    title: "Conversation",
    parent: null,
  });
  const m1 = add("message.posted", at(1), MAP_MAIN, "m1", USER, {
    role: "user",
    text: "Look at these",
    audience: PEOPLE_AND_AGENT,
  });

  // Threads: one concluding, one open, one withdrawn.
  for (const [c, title, when] of [
    [MAP_THREAD_CONCLUDING, "Fix the build", at(2)],
    [MAP_THREAD_OPEN, "Write the docs", at(3)],
    [MAP_THREAD_WITHDRAWN, "A dead end", at(3, 30)],
  ] as const)
    add("conversation.created", when, c, null, USER, { conversation: c, title, parent: m1 });
  const cites = { thread: MAP_THREAD_CONCLUDING, parent: m1, messages: 2, produced: [] };
  add("thread.conclusion_proposed", at(5), MAP_THREAD_CONCLUDING, "p1", AGENT, {
    text: "The build is fixed.",
    cites,
  });
  add("thread.ended", at(6), MAP_THREAD_WITHDRAWN, "e1", USER, {
    state: "withdrawn",
    reason: "not needed",
  });

  // Steps: completed, failed (open), unfinished, failed then acknowledged.
  const step = (
    item: string,
    when: string,
    tool: string,
    conv = MAP_MAIN,
    toolUseId = `tu-${item}`,
  ) =>
    add("step.started", when, conv, item, USER, {
      idempotencyKey: `key-${item}`,
      toolUseId,
      name: tool,
      input: {},
      decision: "approved-by-user",
    });
  const s1 = step("s1", at(7), "mcp__kiro-remote__kiro_launch_session");
  add("step.completed", at(7, 30), MAP_MAIN, "s1c", USER, {
    started: s1,
    idempotencyKey: "key-s1",
    resultSummary: "launched",
  });
  const s2 = step("s2", at(8), "mcp__kiro-remote__kiro_send_prompt");
  add("step.failed", at(8, 10), MAP_MAIN, "s2f", USER, {
    started: s2,
    idempotencyKey: "key-s2",
    resultSummary: "boom",
  });
  step("s3", at(9), "mcp__kiro-remote__kiro_set_config");
  const s4 = step("s4", at(10), "mcp__kiro-remote__kiro_delete_session", MAP_THREAD_OPEN);
  add("step.failed", at(10, 5), MAP_THREAD_OPEN, "s4f", USER, {
    started: s4,
    idempotencyKey: "key-s4",
    resultSummary: "nope",
  });
  add("interrupt.settled", at(11), MAP_THREAD_OPEN, "s4x", USER, {
    key: `failed:${s4}`,
    kind: "failed-step",
    outcome: "acknowledged",
    started: s4,
    via: null,
    detail: {},
  });

  // Interrupts: a call without asking, hosted permissions (one cleared), local prompts.
  add("agent.anomaly", at(12), MAP_MAIN, "a1", AGENT, {
    kind: "call-without-permission",
    toolUseId: "tu-a1",
    name: "Bash",
    input: {},
    status: "completed",
  });
  const raise = (
    when: string,
    conv: string,
    item: string,
    kind: "permission" | "acceptance" | "failed-check",
    k: string,
    target: { type: string; id: string } | null,
    summary: string,
    detail: Record<string, unknown> = {},
  ) =>
    add("interrupt.raised", when, conv, item, RESOLVER, {
      key: key(k),
      kind,
      target,
      summary,
      detail,
    });
  const session = { type: "kiro-session", id: MAP_SESSION };
  raise(at(13), MAP_MAIN, "r1", "permission", `perm:${MAP_SESSION}:1`, session, "Run the tests?");
  raise(at(13, 30), MAP_MAIN, "r2", "permission", `perm:${MAP_SESSION}:2`, session, "Edit a file?");
  add("interrupt.cleared", at(14), MAP_MAIN, "r2c", RESOLVER, {
    key: `perm:${MAP_SESSION}:2`,
    kind: "permission",
    reason: "answered elsewhere",
  });
  add("agent.permission_asked", at(15), MAP_MAIN, "q1", AGENT, {
    toolUseId: "tu-q1",
    name: "mcp__kiro-remote__kiro_delete_session",
    input: {},
  });
  add("agent.permission_asked", at(15, 30), MAP_MAIN, "q2", AGENT, {
    toolUseId: "tu-q2",
    name: "mcp__kiro-remote__kiro_cancel_turn",
    input: {},
  });
  // The person allowed q1: the step that followed carries its tool use id, and it completed.
  const sq1 = step("sq1", at(16), "mcp__kiro-remote__kiro_delete_session", MAP_MAIN, "tu-q1");
  add("step.completed", at(16, 20), MAP_MAIN, "sq1c", USER, {
    started: sq1,
    idempotencyKey: "key-sq1",
    resultSummary: "deleted",
  });

  // Stubs: a Kiro session that goes from running to waiting, and three pull requests.
  const refs: [string, string, Record<string, unknown>, string][] = [
    ["kiro-session", MAP_SESSION, { status: "running", title: "Fix the build" }, at(17)],
    ["pull-request", MAP_PR_MERGED, pullRequestState(1), at(17, 10)],
    ["pull-request", MAP_PR_READY, pullRequestState(2), at(17, 20)],
    ["pull-request", MAP_PR_FAILING, pullRequestState(3, { draft: true }), at(17, 30)],
  ];
  refs.forEach(([type, id, snapshot, when], i) => {
    add("reference.made", when, MAP_MAIN, `ref${i}`, RESOLVER, {
      from: m1,
      target: { type, id },
      kind: "explicit",
      relation: "mentions",
      source: "text",
      snapshot,
    });
  });
  add("status.observed", at(18), MAP_MAIN, "o1", RESOLVER, {
    target: { type: "kiro-session", id: MAP_SESSION },
    state: { status: "awaiting_permission", title: "Fix the build", pendingPermissions: 1 },
  });
  add("status.observed", at(19), MAP_MAIN, "o2", RESOLVER, {
    target: { type: "pull-request", id: MAP_PR_MERGED },
    state: pullRequestState(1, { state: "merged" }),
  });
  add("status.observed", at(19, 30), MAP_MAIN, "o3", RESOLVER, {
    target: { type: "pull-request", id: MAP_PR_FAILING },
    state: pullRequestState(3, {
      draft: false,
      checks: [
        { name: "ci", source: "check-run", status: "completed", conclusion: "failure", url: null },
      ],
    }),
  });

  // Acceptance requests: one accepted, one waiting for a yes, one whose evidence went red.
  const request = (n: number, when: string) =>
    raise(
      when,
      MAP_MAIN,
      `ar${n}`,
      "acceptance",
      `accept:pull-request:nikovirtala/draft/pull/${n}:${n}`,
      { type: "pull-request", id: `nikovirtala/draft/pull/${n}` },
      `nikovirtala/draft#${n}: ready to merge`,
      { acceptance: "pull-request", title: `Change ${n}` },
    );
  request(1, at(20));
  request(2, at(20, 30));
  request(3, at(21));
  add("interrupt.cleared", at(22), MAP_MAIN, "ar3c", RESOLVER, {
    key: "accept:pull-request:nikovirtala/draft/pull/3:3",
    kind: "acceptance",
    reason: "a check failed",
  });
  add("interrupt.settled", at(23), MAP_MAIN, "ar1s", USER, {
    key: "accept:pull-request:nikovirtala/draft/pull/1:1",
    kind: "acceptance",
    outcome: "accepted",
    started: null,
    via: null,
    detail: {},
  });

  await log.append(out);
}
