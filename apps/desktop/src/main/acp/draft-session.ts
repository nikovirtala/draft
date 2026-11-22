import { createHash } from "node:crypto";
import {
  canonicalJson,
  type DraftTool,
  draftToolName,
  loggedInput,
  type PolicyContext,
  toolPolicy,
} from "@nikovirtala/draft-core";
import type { DraftCallResult, DraftSessionHandle } from "./draft-server.ts";
import { FolderTools } from "./folder-tools.ts";
import type { TurnMapper } from "./turn.ts";

/**
 * One agent session's draft tools: what its MCP server hands a call to. It applies the policy
 * (`toolPolicy`), lets the turn's mapper ask the person and record the step, and runs the call in
 * the trusted folder with the agent's environment (no credentials of the person's).
 *
 * A request that arrives again with the same JSON-RPC id, tool and input within a turn is a retry:
 * it gets the first call's result and nothing runs a second time, whether the first is still
 * waiting for the person or is done.
 */
export class DraftSession implements DraftSessionHandle {
  readonly tools: readonly DraftTool[];
  private readonly files: FolderTools;
  private ledger = new Map<string, Promise<DraftCallResult>>();
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
      this.ledger = new Map();
      this.ledgerTurn = turn;
    }
    const key = `${requestId}:${tool}:${createHash("sha256")
      .update(canonicalJson(input ?? null))
      .digest("hex")}`;
    const prior = this.ledger.get(key);
    if (prior !== undefined) return prior;
    const result = this.run(turn, tool, input, signal);
    this.ledger.set(key, result);
    return result;
  }

  private async run(
    turn: TurnMapper,
    tool: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<DraftCallResult> {
    const verdict = this.tools.some((t) => t.name === tool)
      ? toolPolicy(tool, input, this.o.ctx)
      : ({
          class: "refused",
          reason: `${tool} is not one of the tools this session offers`,
        } as const);
    const id = `draft-${this.o.id}-${++this.seq}`;
    const args =
      verdict.class === "refused" ? ((input ?? {}) as Record<string, unknown>) : verdict.input;
    return turn.draftCall({
      id,
      name: draftToolName(tool),
      shown: loggedInput(typeof args === "object" && args !== null ? args : {}, (s) =>
        createHash("sha256").update(s).digest("hex"),
      ),
      verdict,
      signal,
      run: (o) => {
        if (verdict.class === "refused") throw new Error(verdict.reason);
        return this.files.run(verdict, {
          signal,
          ...(o.idempotencyKey === undefined ? {} : { idempotencyKey: o.idempotencyKey }),
        });
      },
    });
  }
}
