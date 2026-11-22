import { createHash } from "node:crypto";
import {
  canonicalJson,
  type DraftTool,
  draftToolName,
  loggedInput,
  type PolicyContext,
  type ToolVerdict,
  toolPolicy,
} from "@nikovirtala/draft-core";
import { type CallPhase, type CallPolicy, stillWaitingText, TOO_LATE_TEXT } from "./call-policy.ts";
import type { DraftCallResult, DraftSessionHandle } from "./draft-server.ts";
import { FolderTools } from "./folder-tools.ts";
import type { TurnMapper } from "./turn.ts";

/**
 * One agent session's draft tools: what its MCP server hands a call to. It applies the policy
 * (`toolPolicy`), lets the turn's mapper ask the person and record the step, and runs the call in
 * the trusted folder with the agent's environment (no credentials of the person's).
 *
 * A call is not tied to the request that brought it. The agent's MCP client gives up on a request
 * after its own timeout, and a person may take longer, so a call lives on its own and a request
 * only waits for it:
 * - **The same call** is the same tool, the same input after the policy has parsed it (defaults
 *   filled in, keys in any order) and the same turn. A request for a call that is pending joins
 *   it: the person isn't asked a second time and nothing runs twice. The JSON-RPC id doesn't
 *   count, because the agent's client numbers its requests anew.
 * - **A request is held** for `policy.holdMs`, then answered "still deciding, call again". The
 *   call carries on. A request the agent hung up on is dropped; the call carries on too.
 * - **A call runs only while a request is waiting for it.** The person's yes is kept until one
 *   is, so a change is never made while the agent is not there to be told of it. A no is kept the
 *   same way, and the next request gets it.
 * - **It ends** when a request collects its result, when the turn ends or is cancelled, or
 *   `policy.retainMs` after it began. A client that timed out may have been sent the result a
 *   moment before its cancellation arrived: a cancellation of the collecting request within
 *   `policy.cancelGraceMs` gives the result back to the next request. Then a late yes is not acted on and a result nobody
 *   collected is dropped. A step begins only after the yes and a request waiting, so no step is
 *   left open by a call nobody comes back for.
 * - A request that arrives again with the same JSON-RPC id, tool and input within a turn is a
 *   retry: it gets the first request's answer, and nothing runs a second time.
 */
export class DraftSession implements DraftSessionHandle {
  readonly tools: readonly DraftTool[];
  private readonly files: FolderTools;
  /** Requests by JSON-RPC id, tool and input: a retry of one request. */
  private byRequest = new Map<string, Promise<DraftCallResult>>();
  /** Calls not yet collected, by tool and input: the same call across requests. */
  private pending = new Map<string, PendingCall>();
  /** Calls a request collected, by that request's JSON-RPC id, until the cancel grace is over. */
  private collected = new Map<
    string | number,
    { key: string; requestKey: string; call: PendingCall }
  >();
  private ledgerTurn: TurnMapper | null = null;
  private seq = 0;

  constructor(
    private readonly o: {
      /** Names the session in the ids of its calls. */
      id: string;
      tools: readonly DraftTool[];
      ctx: PolicyContext & { folder: string };
      /** The agent's environment: draft's override of the person's (environment.ts). */
      env: Record<string, string>;
      /** The turn that is running now, or null between turns. */
      turn: () => TurnMapper | null;
      policy: CallPolicy;
    },
  ) {
    this.tools = o.tools;
    this.files = new FolderTools({ ctx: o.ctx, env: o.env });
  }

  call(
    tool: string,
    input: unknown,
    requestId: string | number,
    signal: AbortSignal,
  ): Promise<DraftCallResult> {
    const turn = this.o.turn();
    if (turn === null)
      return Promise.resolve({
        text: "draft has no turn waiting for this call, so it did not run it.",
        isError: true,
      });
    if (turn !== this.ledgerTurn) {
      this.byRequest = new Map();
      this.ledgerTurn = turn;
    }
    const verdict = this.verdictFor(tool, input);
    const digest = createHash("sha256")
      .update(canonicalJson(verdict.class === "refused" ? (input ?? null) : verdict.input))
      .digest("hex");
    const requestKey = `${requestId}:${tool}:${digest}`;
    const prior = this.byRequest.get(requestKey);
    if (prior !== undefined) return prior;

    const callKey = `${tool}:${digest}`;
    let call = this.pending.get(callKey);
    if (call === undefined || call.turn !== turn) {
      call?.end();
      call = this.begin(turn, callKey, tool, input, verdict);
    }
    const held = call;
    const answer = call.wait(signal).then((r) => {
      // A request answered "still deciding" is not the call's answer: a retry may wait again.
      if (r.waiting) this.byRequest.delete(requestKey);
      else if (!signal.aborted) {
        this.collected.set(requestId, { key: callKey, requestKey, call: held });
        held.collectedBy(() => {
          if (this.collected.get(requestId)?.call === held) this.collected.delete(requestId);
        });
      }
      return r.result;
    });
    this.byRequest.set(requestKey, answer);
    return answer;
  }

  /**
   * The client cancelled a request. If that request had collected a call's result a moment ago,
   * the client never saw it: the call is pending again, with its result, for the next request.
   */
  cancelled(requestId: string | number): void {
    const c = this.collected.get(requestId);
    if (c === undefined) return;
    this.collected.delete(requestId);
    if (!c.call.revive()) return;
    this.byRequest.delete(c.requestKey);
    this.pending.set(c.key, c.call);
  }

  /** The turn is over, or was cancelled: every call it left pending ends here. */
  turnEnded(turn: TurnMapper): void {
    for (const call of [...this.pending.values()]) if (call.turn === turn) call.end();
    for (const { call } of [...this.collected.values()]) if (call.turn === turn) call.end();
  }

  private verdictFor(tool: string, input: unknown): ToolVerdict {
    return this.tools.some((t) => t.name === tool)
      ? toolPolicy(tool, input, this.o.ctx)
      : { class: "refused", reason: `${tool} is not one of the tools this session offers` };
  }

  private begin(
    turn: TurnMapper,
    key: string,
    tool: string,
    input: unknown,
    verdict: ToolVerdict,
  ): PendingCall {
    const call = new PendingCall(turn, tool, this.o.policy, () => {
      if (this.pending.get(key) === call) this.pending.delete(key);
    });
    this.pending.set(key, call);
    call.start(this.run(turn, tool, input, verdict, call));
    return call;
  }

  private async run(
    turn: TurnMapper,
    tool: string,
    input: unknown,
    verdict: ToolVerdict,
    call: PendingCall,
  ): Promise<DraftCallResult> {
    const id = `draft-${this.o.id}-${++this.seq}`;
    const args =
      verdict.class === "refused" ? ((input ?? {}) as Record<string, unknown>) : verdict.input;
    try {
      return await turn.draftCall({
        id,
        name: draftToolName(tool),
        shown: loggedInput(typeof args === "object" && args !== null ? args : {}, (s) =>
          createHash("sha256").update(s).digest("hex"),
        ),
        verdict,
        signal: call.signal,
        admit: () => call.admit(),
        phase: (p) => call.setPhase(p),
        run: (o) => {
          if (verdict.class === "refused") throw new Error(verdict.reason);
          return this.files.run(verdict, {
            signal: call.signal,
            ...(o.idempotencyKey === undefined ? {} : { idempotencyKey: o.idempotencyKey }),
          });
        },
      });
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
}

/** What a request gets: the call's result, or the news that the call is still undecided. */
interface Answer {
  result: DraftCallResult;
  /** True when it is "call again", not the call's result. */
  waiting: boolean;
}

/**
 * One call of the agent's, from its first request until a request collects its result, the turn
 * ends or the time bound passes. It knows nothing of HTTP: requests `wait` for it.
 */
class PendingCall {
  /** Aborted when the call ends: stops a command that is still running. */
  private readonly ended = new AbortController();
  private waiters = 0;
  private phase: CallPhase = "deciding";
  private outcome: Promise<DraftCallResult> | null = null;
  private done = false;
  private isEnded = false;
  private result: DraftCallResult | null = null;
  private onGraceOver: (() => void) | null = null;
  /** Woken when a request starts waiting and when the call ends. */
  private attached: (() => void)[] = [];
  private timer: NodeJS.Timeout;

  constructor(
    readonly turn: TurnMapper,
    private readonly tool: string,
    private readonly policy: CallPolicy,
    private readonly forget: () => void,
  ) {
    this.timer = setTimeout(() => this.end(), policy.retainMs);
    this.timer.unref();
  }

  get signal(): AbortSignal {
    return this.ended.signal;
  }

  start(outcome: Promise<DraftCallResult>): void {
    this.outcome = outcome.then((r) => {
      this.done = true;
      this.result = r;
      return r;
    });
  }

  setPhase(p: CallPhase): void {
    this.phase = p;
  }

  /**
   * Resolves while a request is waiting for the call, and refuses when the call has ended: the
   * mapper begins the step only after this, so a yes that nobody is there to hear starts nothing.
   */
  async admit(): Promise<void> {
    while (!this.isEnded && this.waiters === 0)
      await new Promise<void>((resolve) => this.attached.push(resolve));
    if (this.isEnded) throw new Error(TOO_LATE_TEXT);
  }

  private wake(): void {
    const woken = this.attached;
    this.attached = [];
    for (const w of woken) w();
  }

  /** Holds a request for the call, for at most the policy's time. */
  wait(requestGone: AbortSignal): Promise<Answer> {
    this.waiters++;
    this.wake();
    return new Promise<Answer>((resolve) => {
      let settled = false;
      const finish = (a: Answer, collected: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(hold);
        requestGone.removeEventListener("abort", gone);
        this.waiters--;
        // The result leaves with this request: the call is over, and the same arguments next
        // time are a new call. A request that was hung up on didn't collect it.
        if (collected && !requestGone.aborted) this.collect();
        resolve(a);
      };
      const hold = setTimeout(
        () =>
          finish(
            {
              result: { text: stillWaitingText(this.tool, this.phase), isError: false },
              waiting: true,
            },
            false,
          ),
        this.policy.holdMs,
      );
      const gone = () =>
        finish(
          {
            result: { text: stillWaitingText(this.tool, this.phase), isError: false },
            waiting: true,
          },
          false,
        );
      requestGone.addEventListener("abort", gone, { once: true });
      if (requestGone.aborted) gone();
      void this.outcome?.then((r) => finish({ result: r, waiting: false }, true));
    });
  }

  /** A request took the result: the call leaves the pending list, for the cancel grace. */
  private collect(): void {
    this.forget();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.end(), this.policy.cancelGraceMs);
    this.timer.unref();
  }

  /** Tells the call what to forget when the cancel grace is over. */
  collectedBy(onGraceOver: () => void): void {
    this.onGraceOver = onGraceOver;
  }

  /**
   * The request that took the result was cancelled: the call is pending again, with its result.
   * False when it has ended since.
   */
  revive(): boolean {
    if (this.isEnded || this.result === null) return false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.end(), this.policy.retainMs);
    this.timer.unref();
    return true;
  }

  /** The call is over. Idempotent. */
  end(): void {
    if (this.isEnded) return;
    this.isEnded = true;
    clearTimeout(this.timer);
    this.forget();
    this.onGraceOver?.();
    // A call that is done keeps nothing running. One that is not (a command, a decision) stops,
    // and a decision that arrives later finds `admit` refusing.
    if (!this.done) this.ended.abort();
    this.wake();
  }
}
