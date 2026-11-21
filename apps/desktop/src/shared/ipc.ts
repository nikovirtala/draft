/**
 * The bridge between the renderer and the main process. The renderer only ever sees view state:
 * no API key, no token and no file system access crosses it.
 */

export interface Segment {
  kind: "text" | "view";
  text?: string;
  source?: string;
}

export interface Reference {
  target: string;
  type: string;
  id: string;
  kind: string;
  source: string;
  snapshot: Record<string, unknown>;
}

export interface Message {
  address: string;
  role: "user" | "agent";
  at: string;
  text: string;
  segments: Segment[];
  references: Reference[];
  /** Who the message is for; `agent: false` is an aside. */
  audience: { people: "all" | string[]; agent: boolean };
}

export interface Stub {
  target: string;
  type: string;
  id: string;
  state: Record<string, unknown>;
  observedAt: string;
}

export interface Prompt {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

/** One block of the conversation, in log order. */
export type Block =
  | { kind: "message"; address: string }
  | {
      kind: "unknown";
      id: string;
      type: string;
      schema: number;
      reason: "unknown-type" | "newer-schema";
      at: string | null;
    }
  | {
      kind: "interrupt";
      cause: "unfinished-step" | "unasked-call";
      id: string;
      tool: string;
      input: unknown;
      idempotencyKey: string | null;
      at: string;
    }
  | {
      kind: "notice";
      id: string;
      what: "log-recovered";
      sidecar: string;
      bytes: number;
      at: string;
    };

export interface ConversationState {
  context: string;
  conversation: string;
  title: string;
  agent: { id: string; model: string; version: string; state: "active" | "paused" };
  messages: Message[];
  timeline: Block[];
  stubs: Record<string, Stub>;
  streaming: { address: string; text: string } | null;
  prompts: Prompt[];
  busy: boolean;
  error: string | null;
}

export type Change =
  | { type: "state"; state: ConversationState }
  | { type: "delta"; address: string; text: string };

/** What the window shows: the conversation, or why the log was refused. */
export type Boot =
  | { kind: "ready"; state: ConversationState }
  | { kind: "refused"; path: string; reason: string };

/** Placement is view state per device, never in the log. Only these two work in this slice. */
export type Placement = "inline" | "minimized";

export interface DraftBridge {
  boot(): Promise<Boot>;
  /** `aside` posts for people only: the agent never reads it. */
  submit(text: string, aside?: boolean): Promise<void>;
  setAgentState(state: "active" | "paused"): Promise<void>;
  answerPrompt(id: string, allow: boolean): Promise<void>;
  setVisible(targets: { type: string; id: string }[]): void;
  reportInvalidView(reason: "not-json" | "schema"): void;
  placements(): Promise<Record<string, Placement>>;
  setPlacement(key: string, placement: Placement): Promise<void>;
  onChange(cb: (c: Change) => void): () => void;
}

export const CHANNELS = {
  boot: "draft:boot",
  submit: "draft:submit",
  setAgentState: "draft:set-agent-state",
  answerPrompt: "draft:answer-prompt",
  setVisible: "draft:set-visible",
  invalidView: "draft:invalid-view",
  placements: "draft:placements",
  setPlacement: "draft:set-placement",
  change: "draft:change",
} as const;
