import { conversationKey, itemAddress, parseAddress } from "./address.ts";
import { type AgentDirectory, singleAgent } from "./agent.ts";
import { buildAgentContext, type ContextSize, contextSize } from "./agent-context.ts";
import {
  type AttentionItem,
  type ConversationOptions,
  ConversationService,
  SerialWriter,
  type ThreadState,
  type UiChange,
  type UiState,
} from "./conversation.ts";
import type { Actor, EventDraft, Target } from "./events.ts";
import { newItemId } from "./ids.ts";

/**
 * A thread as the conversation it branched off shows it: a stub at the branch point with live
 * state. Everything here is computed from the log and from what is waiting now; whether the
 * thread is new to this device is not, because that is view state.
 */
export interface UiThread {
  conversation: string;
  /** The message it branched off, in whichever conversation that message is. */
  parent: string;
  /** The conversation that message is in. */
  parentConversation: string;
  title: string;
  state: ThreadState;
  /** How many threads sit between it and the main conversation; 1 for a thread of the main one. */
  depth: number;
  agent: string;
  messages: number;
  /** References made in it: the things it produced that have a block of their own. */
  artifacts: number;
  /** Permission requests and interrupts waiting on a person. */
  waiting: number;
  busy: boolean;
  /** The start of its latest message, for a preview. */
  last: { role: "user" | "agent"; text: string } | null;
}

/** What `branch` needs; a thread starts on the default agent unless another is chosen. */
export interface BranchOptions {
  agent?: string;
  title?: string;
}

export interface SwitchPreview {
  conversation: string;
  from: string;
  to: string;
  size: ContextSize;
}

export type WorkspaceChange =
  | UiChange
  | { type: "threads"; threads: UiThread[]; attention: AttentionItem[] };

export interface WorkspaceOptions extends ConversationOptions {
  agents?: AgentDirectory;
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const t = line.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The main conversation and its threads. Each conversation runs its own turns and, through the
 * agent runtime, its own agent session; they share one log, one projection and one write order.
 */
export class Workspace {
  readonly main: ConversationService;
  private readonly services = new Map<string, ConversationService>();
  private readonly listeners = new Set<(c: WorkspaceChange) => void>();
  private lastThreads = "";

  private constructor(
    private readonly o: WorkspaceOptions & { writer: SerialWriter; agents: AgentDirectory },
    main: ConversationService,
  ) {
    this.main = main;
    this.watch(main);
    for (const c of o.projection.conversations()) {
      if (c.parent !== null) this.attach(c.conversation);
    }
  }

  static async open(o: WorkspaceOptions): Promise<Workspace> {
    const writer = o.writer ?? new SerialWriter();
    const shared = { ...o, writer, agents: o.agents ?? singleAgent(o.agent) };
    const main = await ConversationService.open(shared);
    return new Workspace(shared, main);
  }

  get mainConversation(): string {
    return this.main.conversation;
  }

  conversation(conversation: string): ConversationService {
    const s = conversation === this.main.conversation ? this.main : this.services.get(conversation);
    if (s === undefined) throw new Error(`no such conversation: ${conversation}`);
    return s;
  }

  agents(): { id: string; label: string }[] {
    return this.o.agents.list();
  }

  defaultAgent(): string {
    return this.o.agents.defaultId;
  }

  onChange(cb: (c: WorkspaceChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private watch(s: ConversationService): void {
    s.onChange((c) => {
      this.emit(c);
      if (c.type === "state") this.emitThreads();
    });
  }

  private attach(conversation: string): ConversationService {
    const existing = this.services.get(conversation);
    if (existing !== undefined) return existing;
    const s = ConversationService.attach(this.o, conversation);
    this.services.set(conversation, s);
    this.watch(s);
    return s;
  }

  private emit(c: WorkspaceChange): void {
    for (const l of this.listeners) l(c);
  }

  private emitThreads(): void {
    if (this.listeners.size === 0) return;
    const threads = this.threads();
    const attention = this.attention();
    const key = JSON.stringify([threads, attention]);
    if (key === this.lastThreads) return;
    this.lastThreads = key;
    this.emit({ type: "threads", threads, attention });
  }

  /** Every conversation's state, the main one first. */
  states(): Record<string, UiState> {
    const out: Record<string, UiState> = { [this.main.conversation]: this.main.state() };
    for (const [id, s] of this.services) out[id] = s.state();
    return out;
  }

  /** Every thread, oldest first, with the live state its stub shows. */
  threads(): UiThread[] {
    const p = this.o.projection;
    const all = p.conversations();
    const depthOf = (conv: string): number => {
      let d = 0;
      let cur = all.find((c) => c.conversation === conv);
      while (cur?.parent != null) {
        d++;
        const parentConv = this.conversationOfMessage(cur.parent);
        cur = all.find((c) => c.conversation === parentConv);
      }
      return d;
    };
    return all
      .filter((c) => c.parent !== null)
      .map((c) => {
        const svc = this.services.get(c.conversation);
        const messages = p.messages(c.conversation);
        const last = messages[messages.length - 1];
        return {
          conversation: c.conversation,
          parent: c.parent as string,
          parentConversation: this.conversationOfMessage(c.parent as string),
          title: c.title,
          state: "open" as const,
          depth: depthOf(c.conversation),
          agent: p.agentOf(c.conversation) ?? this.o.agents.defaultId,
          messages: messages.length,
          artifacts: new Set(p.edges(c.conversation).map((e) => e.target)).size,
          waiting: svc?.attention().length ?? 0,
          busy: svc?.state().busy ?? false,
          last: last === undefined ? null : { role: last.role, text: firstLine(last.text, 120) },
        };
      });
  }

  /** What needs a person, in every conversation, in the order it arose. */
  attention(): AttentionItem[] {
    const items = [this.main, ...this.services.values()].flatMap((s) => s.attention());
    return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  private conversationOfMessage(address: string): string {
    const a = parseAddress(address);
    return conversationKey(a.context, a.conversation as string);
  }

  /**
   * Branches a thread off a message. The thread is a conversation with that message as its
   * parent, and it starts on the default agent unless another configured one is chosen. Its
   * agent session starts with its first turn, from the projection of its own log.
   */
  async branch(
    parentMessage: string,
    user: Extract<Actor, { kind: "user" }>,
    options: BranchOptions = {},
  ): Promise<string> {
    const parent = this.o.projection
      .conversations()
      .flatMap((c) => this.o.projection.messages(c.conversation))
      .find((m) => m.address === parentMessage);
    if (parent === undefined) throw new Error(`no such message: ${parentMessage}`);
    const agent = options.agent ?? this.o.agents.defaultId;
    // Fails for an agent that isn't configured, before anything is written.
    this.o.agents.get(agent);
    const parentAddress = parseAddress(parentMessage);
    const conversation = conversationKey(parentAddress.context, newItemId(this.o.newId));
    const title = options.title ?? (firstLine(parent.text, 48) || "Thread");
    const drafts: EventDraft[] = [
      {
        type: "conversation.created",
        address: `${conversation}@1`,
        conversation,
        actor: user,
        traceId: null,
        data: { conversation, title, parent: parentMessage },
      },
      {
        type: "agent.selected",
        address: itemAddress(conversation, newItemId(this.o.newId)),
        conversation,
        actor: user,
        traceId: null,
        data: { agent, previous: null, reason: "thread-start", context: null },
      },
    ];
    await this.o.writer.run(async () => {
      const sealed = await this.o.log.append(drafts);
      for (const e of sealed) this.o.projection.apply(e);
    });
    this.attach(conversation);
    this.emitThreads();
    this.emit({ type: "state", state: this.conversation(conversation).state() });
    return conversation;
  }

  /** What switching a thread to another agent would start the new session from. */
  previewSwitch(conversation: string, to: string): SwitchPreview {
    this.o.agents.get(to);
    const from = this.o.projection.agentOf(conversation) ?? this.o.agents.defaultId;
    return {
      conversation,
      from,
      to,
      size: contextSize(buildAgentContext(this.o.projection, conversation)),
    };
  }

  /**
   * Switches a conversation to another agent: an explicit request by a person, logged as an
   * event. The old agent's session ends, and the new one starts with the next turn from
   * `buildAgentContext`, the same path as recovering from a crash.
   */
  async switchAgent(
    conversation: string,
    to: string,
    user: Extract<Actor, { kind: "user" }>,
  ): Promise<SwitchPreview> {
    const svc = this.conversation(conversation);
    if (svc.state().busy) throw new Error("wait for the agent to finish its turn before switching");
    const preview = this.previewSwitch(conversation, to);
    if (preview.from === to) throw new Error(`the thread already runs on ${to}`);
    const previous = svc.runtime();
    await this.o.writer.run(async () => {
      const sealed = await this.o.log.append([
        {
          type: "agent.selected",
          address: itemAddress(conversation, newItemId(this.o.newId)),
          conversation,
          actor: user,
          traceId: null,
          data: { agent: to, previous: preview.from, reason: "switch", context: preview.size },
        },
      ]);
      for (const e of sealed) this.o.projection.apply(e);
    });
    previous.closeConversation(conversation);
    this.emit({ type: "state", state: svc.state() });
    this.emitThreads();
    return preview;
  }

  /** The stubs' targets on screen, in any conversation; only these are polled. */
  setVisible(targets: readonly Target[]): void {
    this.main.setVisible(targets);
  }

  /** Polls the visible stubs that are due. The host calls this on a timer. */
  async tick(): Promise<void> {
    await this.main.tick();
  }

  async close(): Promise<void> {
    for (const s of this.services.values()) await s.close();
    await this.main.close();
  }
}
