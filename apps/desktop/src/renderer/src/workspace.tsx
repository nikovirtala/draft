import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentOption,
  Attention,
  BlockRegistration,
  Boot,
  ContextView,
  ConversationState,
  MapSelection,
  Move,
  OpenTarget,
  Stub,
  Thread,
  View,
} from "../../shared/ipc.ts";
import {
  type Entry,
  type FocusTarget,
  panelBlock,
  splitAttention,
} from "../../shared/placement.ts";

type Ready = Extract<Boot, { kind: "ready" }>;

/** What a selection is: a block, or a conversation someone last spoke in. */
export interface Selection {
  block: string | null;
  conversation: string;
}

export interface Workspace {
  /** The context this window shows. */
  context: ContextView;
  main: string;
  states: Record<string, ConversationState>;
  threads: Thread[];
  attention: Attention[];
  view: View;
  /**
   * Every live status, newest known state. Statuses are polled once for the whole device, so the
   * state a conversation carries can be older than another's: the newest observation wins.
   */
  stubs: Record<string, Stub>;
  agents: AgentOption[];
  defaultAgent: string;
  /** The block this window shows in full; null for the main window. */
  windowBlock: string | null;
  selection: Selection;
  select: (s: Selection) => void;
  /** Counts of what needs a person: in the focused conversation, and elsewhere. */
  attentionCount: { inFocus: number; elsewhere: number };
  /** Whether a conversation's interrupts show in full: always, except outside the focus. */
  showsInterrupts: (conversation: string) => boolean;
  entry: (address: string) => Entry | undefined;
  depthOf: (conversation: string) => number;
  register: (b: BlockRegistration) => void;
  move: (m: Move) => void;
  toggleFocus: () => void;
  leaveFocus: () => void;
  branch: (parentMessage: string, agent?: string) => void;
  threadOf: (conversation: string) => Thread | undefined;
  /** The stubs being read now, by `type:id`, in any conversation of this window. */
  resolving: ReadonlySet<string>;
  /** Names the log as the main process last announced it; a map asks again when it changes. */
  mapHead: string;
  /** The cell a map block has open on this device. */
  mapCell: (block: string) => MapSelection | null;
  selectMapCell: (block: string, cell: MapSelection | null) => void;
  /** Goes to where an item of the map lives: its thread or its stub. */
  open: (target: OpenTarget) => Promise<void>;
}

export const WorkspaceContext = createContext<Workspace | null>(null);
const Ctx = WorkspaceContext;

export function useWorkspace(): Workspace {
  const w = useContext(Ctx);
  if (w === null) throw new Error("no workspace");
  return w;
}

/** Keeps every conversation's state, the threads, the attention and this device's view in step with the main process. */
export function WorkspaceProvider({ boot, children }: { boot: Ready; children: ReactNode }) {
  const [states, setStates] = useState(boot.states);
  const [threads, setThreads] = useState(boot.threads);
  const [attention, setAttention] = useState(boot.attention);
  const [view, setView] = useState(boot.view);
  const [selection, setSelection] = useState<Selection>({ block: null, conversation: boot.main });
  const [mapHead, setMapHead] = useState("");
  const pending = useRef(new Map<string, BlockRegistration>());
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(
    () =>
      window.draft.onChange((c) => {
        switch (c.type) {
          case "state":
            setStates((all) => ({ ...all, [c.state.conversation]: c.state }));
            break;
          case "delta":
            setStates((all) => {
              const s = all[c.conversation];
              if (s === undefined || s.streaming === null || s.streaming.address !== c.address)
                return all;
              return {
                ...all,
                [c.conversation]: {
                  ...s,
                  streaming: { ...s.streaming, text: s.streaming.text + c.text },
                },
              };
            });
            break;
          case "threads":
            setThreads(c.threads);
            setAttention(c.attention);
            break;
          case "view":
            setView(c.view);
            break;
          case "map":
            setMapHead(c.head);
            break;
        }
      }),
    [],
  );

  const register = useCallback((b: BlockRegistration) => {
    if (viewRef.current.layout.blocks[b.info.address] !== undefined) return;
    pending.current.set(b.info.address, b);
    flush.current ??= setTimeout(() => {
      flush.current = null;
      const blocks = [...pending.current.values()];
      pending.current.clear();
      void window.draft.ensureBlocks(blocks);
    }, 30);
  }, []);

  const focus = view.layout.focus;
  const value = useMemo<Workspace>(() => {
    const stubs: Record<string, Stub> = {};
    for (const st of Object.values(states)) {
      for (const [k, v] of Object.entries(st.stubs)) {
        const known = stubs[k];
        if (known === undefined || known.observedAt < v.observedAt) stubs[k] = v;
      }
    }
    const depths = new Map(threads.map((t) => [t.conversation, t.depth]));
    const count = splitAttention(attention, focus);
    const toggle = () => {
      if (focus !== null) return void window.draft.focus(null);
      const target: FocusTarget =
        selection.block !== null && view.layout.blocks[selection.block] !== undefined
          ? { block: selection.block }
          : { conversation: selection.conversation };
      void window.draft.focus(target);
    };
    const open = async (target: OpenTarget): Promise<void> => {
      // Something outside draft opens by its links, which the list shows.
      if (target.kind === "links") return;
      let info: BlockRegistration["info"];
      if (target.kind === "stub") {
        const address = `${target.from}#${target.target}`;
        info = {
          address,
          kind: "status",
          home: target.conversation,
          depth: depths.get(target.conversation) ?? 0,
          opens: null,
          title: target.target.split(":").slice(1).join(":"),
        };
      } else {
        const thread = threads.find((t) => t.conversation === target.conversation);
        if (thread === undefined) {
          // The main conversation: bring it to the front, at the block if it has one.
          setSelection({ block: null, conversation: target.conversation });
          if (target.anchor !== null) scrollToAnchor(target.anchor);
          return;
        }
        info = {
          address: thread.conversation,
          kind: "thread",
          home: thread.parentConversation,
          depth: depths.get(thread.parentConversation) ?? 0,
          opens: thread.conversation,
          title: thread.title,
        };
      }
      const known = view.layout.blocks[info.address];
      // A block that was never on screen on this device is made first, where it was made.
      if (known === undefined) await window.draft.ensureBlocks([{ info, initial: "minimized" }]);
      if (known?.placement === "panel" || known?.placement === "window") return;
      // Inside a thread the panel is the thread's: such a block opens in a window.
      const depth = known?.info.depth ?? info.depth;
      await window.draft.move({
        type: depth === 0 ? "open-in-panel" : "pop-out",
        block: info.address,
      });
    };
    const resolving = new Set(Object.values(states).flatMap((s) => s.resolving));
    return {
      resolving,
      mapHead,
      mapCell: (block) => view.cells[block] ?? null,
      selectMapCell: (block, cell) => void window.draft.selectMapCell(block, cell),
      open,
      context: boot.context,
      main: boot.main,
      states,
      threads,
      attention,
      view,
      stubs,
      agents: boot.agents,
      defaultAgent: boot.defaultAgent,
      windowBlock: boot.block,
      selection,
      select: setSelection,
      attentionCount: count,
      showsInterrupts: (conversation) => focus === null || focus.conversation === conversation,
      entry: (address) => view.layout.blocks[address],
      depthOf: (conversation) => depths.get(conversation) ?? 0,
      register,
      move: (m) => void window.draft.move(m),
      toggleFocus: toggle,
      leaveFocus: () => void window.draft.focus(null),
      branch: (parentMessage, agent) => void window.draft.branch(parentMessage, agent),
      threadOf: (conversation) => threads.find((t) => t.conversation === conversation),
    };
  }, [boot, states, threads, attention, view, selection, focus, register, mapHead]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function panelEntry(w: Pick<Workspace, "view">): Entry | null {
  return panelBlock(w.view.layout);
}

/** Scrolls the conversation to the block of an interrupt or step, when it is on screen. */
function scrollToAnchor(anchor: string): void {
  for (const key of [anchor, `failed:${anchor}`]) {
    const el = [...document.querySelectorAll<HTMLElement>("[data-key]")].find(
      (e) => e.dataset.key === key,
    );
    if (el !== undefined) {
      el.scrollIntoView({ block: "center" });
      return;
    }
  }
}
