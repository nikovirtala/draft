/**
 * The bridge between the renderer and the main process. The renderer only ever sees view state:
 * no API key, no token and no file system access crosses it.
 */
import type { BlockInfo, Focus, FocusTarget, Layout, Move, Refusal } from "./placement.ts";

/** What an agent's process was not given of the person's environment: names only, never values. */
export interface AgentEnvironment {
  withheld: { name: string; group: string }[];
  /** Variables draft set in place of what the agent would have found. */
  overridden: string[];
  /** Variables passed through on purpose (`passEnv` in config.json). */
  passed: string[];
  /** `passEnv` names draft refuses to pass (its own settings). */
  refused: string[];
}

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
  /** For an item of another context: pulled into this conversation's agent context. */
  pulled: boolean;
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
      cause: InterruptCause;
      /** The interrupt's key: what settling it names. */
      id: string;
      state: "open" | "settled" | "cleared";
      tool: string;
      input: unknown;
      idempotencyKey: string | null;
      at: string;
      summary: string;
      detail: Record<string, unknown>;
      target: { type: string; id: string } | null;
      /** What a person can settle it as, while it is open. */
      outcomes: string[];
      settled: { outcome: string; at: string; by: string; via: string | null } | null;
      cleared: { reason: string; at: string } | null;
    }
  | {
      kind: "notice";
      id: string;
      what: "log-recovered";
      sidecar: string;
      bytes: number;
      at: string;
    }
  | { kind: "note"; id: string; what: string; text: string; at: string };

/** Why something needs a person, in the order of the attention order's ranks. */
export type InterruptCause =
  | "permission"
  | "failed-check"
  | "merge-conflict"
  | "changes-requested"
  | "failed-step"
  | "unasked-call"
  | "unfinished-step"
  | "conclusion"
  | "review-requested"
  | "acceptance";

export type ThreadStateName = "open" | "concluding" | "wrapped-up" | "superseded" | "withdrawn";

/** What a thread concluded, and what it rests on. */
export interface Conclusion {
  address: string;
  text: string;
  cites: {
    thread: string;
    parent: string;
    messages: number;
    produced: { type: string; id: string }[];
  };
  proposedAt: string;
  wrappedAt: string | null;
}

/** A sentence that asked to open a context, waiting for one confirmation. */
export interface Proposal {
  id: string;
  intent: { kind: "open"; name: string } | { kind: "new"; folder: string };
  /** The message that asked for it. */
  message: string;
}

export interface ConversationState {
  context: string;
  conversation: string;
  /** Null for the main conversation. */
  thread: {
    state: ThreadStateName;
    conclusion: Conclusion | null;
    endedReason: string | null;
  } | null;
  /** The message this conversation branched off; null for the main conversation. */
  parent: string | null;
  title: string;
  agent: {
    id: string;
    model: string;
    version: string;
    state: "active" | "paused";
    /** What the agent's process doesn't get of the person's environment, by name; null: nothing known. */
    environment: AgentEnvironment | null;
  };
  messages: Message[];
  timeline: Block[];
  stubs: Record<string, Stub>;
  streaming: { address: string; text: string } | null;
  prompts: Prompt[];
  proposals: Proposal[];
  busy: boolean;
  error: string | null;
}

/** A thread as the conversation it branched off shows it: the live state of its stub. */
export interface Thread {
  conversation: string;
  parent: string;
  parentConversation: string;
  title: string;
  state: ThreadStateName;
  depth: number;
  agent: string;
  messages: number;
  artifacts: number;
  waiting: number;
  /** The conclusion drafted for the main conversation, or the one that wrapped the thread up. */
  conclusion: Conclusion | null;
  endedReason: string | null;
  busy: boolean;
  last: { role: "user" | "agent"; text: string } | null;
}

/** Something that needs a person, in one conversation. */
export interface Attention {
  id: string;
  conversation: string;
  cause: InterruptCause;
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

/** The context a window shows, as far as the window needs to say so. */
export interface ContextView {
  name: string;
  title: string;
  /** The folder its agent works in; null while none is trusted. Device-local, never in a log. */
  folder: { name: string; path: string } | null;
  /** A folder was trusted once and isn't there now. */
  folderMissing: boolean;
}

/** What a person is asked before a folder becomes where a context's agent works. */
export interface TrustQuestion {
  context: string;
  folder: { path: string; name: string; remote: string | null };
  /** The folder came from importing an older data directory's `agent-workspace` link. */
  imported: boolean;
}

/** One context in the recent list: what it is called, where it works and when it was last used. */
export interface ContextListItem {
  name: string;
  title: string;
  folder: string | null;
  lastActivity: string | null;
  /** Open in a window of its own now. */
  open: boolean;
  /** The context of the window that asked. */
  current: boolean;
}

/** What the window shows: the conversation and its threads, or why the log was refused. */
export type Boot =
  | {
      kind: "trust";
      question: TrustQuestion;
    }
  | {
      kind: "ready";
      context: ContextView;
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
  /**
   * Settles an interrupt as the person: allowed, done, retry, acknowledged... An answer to an
   * acceptance request takes the person's words: a `note` for changes requested, a `reason` for
   * a rejection.
   */
  settleInterrupt(
    conversation: string,
    key: string,
    outcome: string,
    input?: { note?: string; reason?: string },
  ): Promise<void>;
  /** Asks a thread's agent to draft its conclusion. */
  wrapUp(conversation: string): Promise<void>;
  confirmConclusion(conversation: string): Promise<void>;
  declineConclusion(conversation: string): Promise<void>;
  endThread(conversation: string, as: "superseded" | "withdrawn", reason: string): Promise<void>;
  /** Answers the question a window asks before its context starts: trust the folder or not. */
  trust(answer: "trusted" | "declined"): Promise<void>;
  /** The recent contexts, the one used last first. */
  contexts(): Promise<ContextListItem[]>;
  /** Opens a context in a window of its own, or brings its window forward. */
  openContext(name: string): Promise<void>;
  /** Asks for a folder with the system's chooser and opens it as a context. */
  chooseFolder(): Promise<void>;
  /** Asks for a data directory with the system's chooser and imports it as a context. */
  chooseImport(): Promise<void>;
  /** A person's answer to a sentence that asked to open a context. */
  answerProposal(conversation: string, id: string, accept: boolean): Promise<void>;
  /** Opens the other context that a reference points into, and records the crossing. */
  followReference(conversation: string, address: string): Promise<void>;
  /** Lets the agent of this conversation read a reference's snapshot, and records the crossing. */
  pullReference(conversation: string, address: string): Promise<void>;
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
  settleInterrupt: "draft:settle-interrupt",
  wrapUp: "draft:wrap-up",
  confirmConclusion: "draft:confirm-conclusion",
  declineConclusion: "draft:decline-conclusion",
  endThread: "draft:end-thread",
  trust: "draft:trust",
  contexts: "draft:contexts",
  openContext: "draft:open-context",
  chooseFolder: "draft:choose-folder",
  chooseImport: "draft:choose-import",
  answerProposal: "draft:answer-proposal",
  followReference: "draft:follow-reference",
  pullReference: "draft:pull-reference",
  change: "draft:change",
} as const;
