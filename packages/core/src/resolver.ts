import { canonicalJson } from "./canonical.ts";
import type { Target } from "./events.ts";
import type { InterruptCandidate } from "./interrupts.ts";
import {
  findSessionIds,
  type KiroPendingPermission,
  type KiroRemoteTools,
  type KiroSessionView,
  pendingPermissions,
  sessionState,
} from "./kiro.ts";

/**
 * A resolver turns references to one type of outside thing into live state. There is one per
 * reference type (Kiro sessions now; pull requests, ark issues and artifact pages later), and what
 * they observe enters the log as status events.
 */
export interface Resolver {
  /** The reference type, e.g. "kiro-session". */
  readonly type: string;
  /** Its version, recorded as the actor of the status events it causes. */
  readonly version: string;
  /** Candidate ids mentioned in some text. Candidates are confirmed by `fetch`. */
  detect(text: string): string[];
  /** The target's current state, or `null` when it doesn't exist. Throws when it can't tell. */
  fetch(id: string): Promise<Record<string, unknown> | null>;
  /**
   * What needs a person, given the target's state: a pure function of the state, so the same
   * state always raises the same interrupts. A resolver whose targets never need anyone has none.
   */
  interrupts?(target: Target, state: Record<string, unknown>): InterruptCandidate[];
  /**
   * Why an interrupt this resolver raised no longer applies, in the target's state now, when it
   * can say more than "the source no longer reports it": an acceptance request names the evidence
   * that went red. Null leaves the generic reason.
   */
  clearedBecause?(
    open: { key: string; detail: Record<string, unknown> },
    target: Target,
    state: Record<string, unknown>,
  ): string | null;
}

export class KiroSessionResolver implements Resolver {
  readonly type = "kiro-session";
  readonly version = "2";
  constructor(private readonly tools: KiroRemoteTools) {}

  /** Each pending permission request is one interrupt, for as long as the session waits on it. */
  interrupts(target: Target, state: Record<string, unknown>): InterruptCandidate[] {
    const pending = Array.isArray(state.permissions)
      ? (state.permissions as KiroPendingPermission[])
      : [];
    const title = typeof state.title === "string" && state.title !== "" ? state.title : "A session";
    return pending.map((p) => ({
      key: `kiro-permission:${target.id}:${p.requestId}`,
      kind: "permission" as const,
      summary: `${title} asks to: ${p.title}`,
      detail: {
        sessionId: target.id,
        requestId: p.requestId,
        title: p.title,
        kind: p.kind,
        options: p.options,
        session: title,
      },
    }));
  }

  detect(text: string): string[] {
    return findSessionIds(text);
  }

  async fetch(id: string): Promise<Record<string, unknown> | null> {
    const got = await this.tools.call("kiro_get_session", { sessionId: id });
    if (got.isError) {
      // kiro-remote reports an unknown or foreign session as a tool error.
      if (/not.?found|unknown|404|no such/i.test(got.text)) return null;
      throw new Error(`kiro_get_session failed: ${got.text.slice(0, 200)}`);
    }
    const session = (got.structured as { session?: KiroSessionView } | null)?.session;
    if (session === undefined || session === null || session.id !== id) return null;
    const perms = await this.tools.call("kiro_list_permissions", {
      sessionId: id,
      status: "pending",
    });
    return sessionState(session, perms.isError ? [] : pendingPermissions(perms.structured));
  }
}

export function sameState(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null,
): boolean {
  return a !== undefined && a !== null && b !== null && canonicalJson(a) === canonicalJson(b);
}

export interface PollerOptions {
  /** First interval after a change, and the interval when a stub becomes visible. */
  readonly baseMs?: number;
  /** The longest interval backoff reaches. */
  readonly maxMs?: number;
  readonly now?: () => number;
}

export interface PollOutcome {
  target: Target;
  outcome: "changed" | "unchanged" | "missing" | "failed";
  nextIntervalMs: number;
}

interface Tracked {
  target: Target;
  intervalMs: number;
  dueAt: number;
  visible: boolean;
  inFlight: boolean;
}

/**
 * Polls the targets whose stubs are on screen, and only those. After a poll that saw no change,
 * or failed, the interval doubles up to `maxMs`; a change resets it to `baseMs`. A status event is
 * written only when the state differs from the last known state.
 */
export class StubPoller {
  private readonly tracked = new Map<string, Tracked>();
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;
  /** Called when a poll starts or ends, so what is being read can be shown. */
  onActivity: () => void = () => {};

  constructor(
    private readonly resolvers: ReadonlyMap<string, Resolver>,
    private readonly known: (target: Target) => Record<string, unknown> | null,
    private readonly observed: (
      target: Target,
      state: Record<string, unknown>,
      resolver: Resolver,
    ) => Promise<void>,
    private readonly report: (o: PollOutcome & { durationMs: number }) => void = () => {},
    o: PollerOptions = {},
  ) {
    this.baseMs = o.baseMs ?? 2_000;
    this.maxMs = o.maxMs ?? 60_000;
    this.now = o.now ?? Date.now;
  }

  /**
   * Replaces the set of targets on screen. A target that comes into view is due at once, with
   * its backoff reset; a target that stays in view keeps its schedule.
   */
  setVisible(targets: readonly Target[]): void {
    const keys = new Set(targets.map((t) => `${t.type}:${t.id}`));
    for (const [k, t] of this.tracked) if (!keys.has(k)) t.visible = false;
    for (const t of targets) {
      const k = `${t.type}:${t.id}`;
      const existing = this.tracked.get(k);
      if (existing === undefined) {
        this.tracked.set(k, {
          target: t,
          intervalMs: this.baseMs,
          dueAt: this.now(),
          visible: true,
          inFlight: false,
        });
      } else if (!existing.visible) {
        existing.visible = true;
        existing.intervalMs = this.baseMs;
        existing.dueAt = Math.min(existing.dueAt, this.now());
      }
    }
  }

  /** The targets being read now, by `type:id`, in the order their polls started. */
  inFlight(): string[] {
    return [...this.tracked.entries()].filter(([, t]) => t.inFlight).map(([k]) => k);
  }

  visible(): Target[] {
    return [...this.tracked.values()].filter((t) => t.visible).map((t) => t.target);
  }

  intervalOf(target: Target): number | null {
    return this.tracked.get(`${target.type}:${target.id}`)?.intervalMs ?? null;
  }

  /** Polls every visible target that is due. Returns what each poll found. */
  async runDue(): Promise<PollOutcome[]> {
    const now = this.now();
    const due = [...this.tracked.values()].filter(
      (t) => t.visible && !t.inFlight && t.dueAt <= now,
    );
    return Promise.all(due.map((t) => this.poll(t)));
  }

  private async poll(t: Tracked): Promise<PollOutcome> {
    const resolver = this.resolvers.get(t.target.type);
    const started = this.now();
    t.inFlight = true;
    this.onActivity();
    let outcome: PollOutcome["outcome"];
    let retryAfterMs = 0;
    try {
      if (resolver === undefined) throw new Error(`no resolver for ${t.target.type}`);
      const state = await resolver.fetch(t.target.id);
      if (state === null) {
        outcome = "missing";
      } else if (sameState(this.known(t.target), state)) {
        outcome = "unchanged";
      } else {
        await this.observed(t.target, state, resolver);
        outcome = "changed";
      }
    } catch (err) {
      outcome = "failed";
      // A source that says when to come back (GitHub's rate limit) is not asked sooner.
      const wait = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
      if (typeof wait === "number" && wait > 0) retryAfterMs = wait;
    } finally {
      t.inFlight = false;
      this.onActivity();
    }
    t.intervalMs = outcome === "changed" ? this.baseMs : Math.min(t.intervalMs * 2, this.maxMs);
    t.dueAt = this.now() + Math.max(t.intervalMs, retryAfterMs);
    const result = {
      target: t.target,
      outcome,
      nextIntervalMs: Math.max(t.intervalMs, retryAfterMs),
    };
    this.report({ ...result, durationMs: this.now() - started });
    return result;
  }
}
