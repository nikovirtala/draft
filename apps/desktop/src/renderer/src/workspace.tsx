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
  ConversationState,
  Move,
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
  main: string;
  states: Record<string, ConversationState>;
  threads: Thread[];
  attention: Attention[];
  view: View;
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
}

const Ctx = createContext<Workspace | null>(null);

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
    return {
      main: boot.main,
      states,
      threads,
      attention,
      view,
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
  }, [boot, states, threads, attention, view, selection, focus, register]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function panelEntry(w: Pick<Workspace, "view">): Entry | null {
  return panelBlock(w.view.layout);
}
