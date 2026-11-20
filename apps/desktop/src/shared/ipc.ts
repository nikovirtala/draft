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

export interface ConversationState {
  context: string;
  conversation: string;
  title: string;
  agent: { model: string; version: string };
  messages: Message[];
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
  submit(text: string): Promise<void>;
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
  answerPrompt: "draft:answer-prompt",
  setVisible: "draft:set-visible",
  invalidView: "draft:invalid-view",
  placements: "draft:placements",
  setPlacement: "draft:set-placement",
  change: "draft:change",
} as const;
