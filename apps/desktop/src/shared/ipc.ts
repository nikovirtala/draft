/**
 * The bridge between the renderer and the main process. The renderer only ever sees view state:
 * no API key, no token and no file system access crosses it.
 */
import type { BlockInfo, Focus, FocusTarget, Layout, Move, Refusal } from "./placement.ts";

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
  /** The message this conversation branched off; null for the main conversation. */
  parent: string | null;
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

/** A thread as the conversation it branched off shows it: the live state of its stub. */
export interface Thread {
  conversation: string;
  parent: string;
  parentConversation: string;
  title: string;
  /** Only `open` exists so far; closing a thread adds states. */
  state: "open";
  depth: number;
  agent: string;
  messages: number;
  artifacts: number;
  waiting: number;
  busy: boolean;
  last: { role: "user" | "agent"; text: string } | null;
}

/** Something that needs a person, in one conversation. */
export interface Attention {
  id: string;
  conversation: string;
  cause: "permission" | "unfinished-step" | "unasked-call";
  at: string;
}

export interface AgentOption {
  id: string;
  label: string;
}

/**
 * What this device shows: placements, focus and which messages of each thread it has shown. View
 * state, per device; none of it is in the log.
 */
export interface View {
  layout: Layout;
  /** Messages of each thread already shown on this device. */
  seen: Record<string, number>;
}

export type Change =
  | { type: "state"; state: ConversationState }
  | { type: "delta"; conversation: string; address: string; text: string }
  | { type: "threads"; threads: Thread[]; attention: Attention[] }
  | { type: "view"; view: View };

/** What the window shows: the conversation and its threads, or why the log was refused. */
export type Boot =
  | {
      kind: "ready";
      main: string;
      states: Record<string, ConversationState>;
      threads: Thread[];
      attention: Attention[];
      view: View;
      agents: AgentOption[];
      defaultAgent: string;
      /** The block this window shows in full, or null for the main window. */
      block: string | null;
    }
  | { kind: "refused"; path: string; reason: string };

/** What starting a thread on another agent would start from: counts and characters, measured. */
export interface SwitchPreview {
  conversation: string;
  from: string;
  to: string;
  size: {
    messages: number;
    openItems: number;
    decisions: number;
    references: number;
    characters: number;
  };
}

export type MoveOutcome = { ok: true } | { ok: false; reason: Refusal };

export type { BlockInfo, Focus, FocusTarget, Layout, Move, Refusal };

/** A block the renderer shows, with where it starts when the device hasn't seen it before. */
export interface BlockRegistration {
  info: BlockInfo;
  initial: "inline" | "minimized";
}

export interface DraftBridge {
  boot(): Promise<Boot>;
  /** `aside` posts for people only: the agent never reads it. */
  submit(conversation: string, text: string, aside?: boolean): Promise<void>;
  setAgentState(conversation: string, state: "active" | "paused"): Promise<void>;
  answerPrompt(conversation: string, id: string, allow: boolean): Promise<void>;
  setVisible(targets: { type: string; id: string }[]): void;
  reportInvalidView(reason: "not-json" | "schema"): void;
  /** Tells this device about blocks that are on screen; a block seen before stays where it is. */
  ensureBlocks(blocks: BlockRegistration[]): Promise<void>;
  /** A person's move. The agent never reaches this: it can only suggest. */
  move(move: Move): Promise<MoveOutcome>;
  /** Enters focus on a block or a conversation, or leaves it with `null`. */
  focus(target: FocusTarget | null): Promise<void>;
  /** Branches a thread off a message; it opens in the panel. */
  branch(parentMessage: string, agent?: string): Promise<void>;
  previewSwitch(conversation: string, agent: string): Promise<SwitchPreview>;
  switchAgent(conversation: string, agent: string): Promise<void>;
  onChange(cb: (c: Change) => void): () => void;
}

export const CHANNELS = {
  boot: "draft:boot",
  submit: "draft:submit",
  setAgentState: "draft:set-agent-state",
  answerPrompt: "draft:answer-prompt",
  setVisible: "draft:set-visible",
  invalidView: "draft:invalid-view",
  ensureBlocks: "draft:ensure-blocks",
  move: "draft:move",
  focus: "draft:focus",
  branch: "draft:branch",
  previewSwitch: "draft:preview-switch",
  switchAgent: "draft:switch-agent",
  change: "draft:change",
} as const;
