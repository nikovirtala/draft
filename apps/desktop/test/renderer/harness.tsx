import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Workspace, WorkspaceContext } from "../../src/renderer/src/workspace.tsx";
import type { ConversationState, DraftBridge, MapSnapshot, Stub } from "../../src/shared/ipc.ts";

/** What a component test needs of the browser: act, a place to mount, and a stand-in for the bridge. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

export interface Mounted {
  root: Root;
  host: HTMLElement;
  unmount(): Promise<void>;
  render(ui: ReactElement): Promise<void>;
}

export async function mount(ui: ReactElement): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(ui));
  return {
    root,
    host,
    render: (next) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** Lets the clock run, and what it wakes (state updates, resolved promises) settle. */
export async function advance(ms: number): Promise<void> {
  const { vi } = await import("vitest");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The working indicators in a mounted tree, by place. */
export function indicators(host: HTMLElement, place?: string): HTMLElement[] {
  const all = [...host.querySelectorAll<HTMLElement>('[data-testid="working"]')];
  return place === undefined ? all : all.filter((e) => e.dataset.place === place);
}

export function conversationState(over: Partial<ConversationState> = {}): ConversationState {
  return {
    context: "local",
    conversation: "local/main",
    thread: null,
    parent: null,
    title: "A conversation",
    agent: {
      id: "kiro",
      model: "unreported",
      version: "1",
      state: "active",
      environment: null,
    },
    messages: [],
    timeline: [],
    stubs: {},
    streaming: null,
    prompts: [],
    proposals: [],
    busy: false,
    resolving: [],
    error: null,
    ...over,
  };
}

export function pullRequestStub(state: string): Stub {
  return {
    target: "pull-request:nikovirtala/draft#36",
    type: "pull-request",
    id: "nikovirtala/draft#36",
    observedAt: "2026-11-23T10:00:00.000Z",
    state: {
      repo: "nikovirtala/draft",
      number: 36,
      title: "Show the map",
      state,
      draft: false,
      checksSummary: { total: 8, passed: 8, failed: 0, pending: 0 },
    },
  };
}

export function emptyMap(over: Partial<MapSnapshot> = {}): MapSnapshot {
  return {
    context: "local",
    position: 0,
    at: null,
    grouping: { id: "state", label: "By state" },
    window: {},
    kinds: [],
    rows: [],
    transitions: [],
    edges: [],
    totals: { items: 0, open: 0, waitingOnPerson: 0 },
    reading: false,
    problems: [],
    ...over,
  };
}

export function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    context: { name: "local", title: "local", folder: null, folderMissing: false },
    main: "local/main",
    states: {},
    threads: [],
    attention: [],
    view: { layout: { blocks: {}, focus: null }, seen: {}, cells: {} },
    stubs: {},
    agents: [],
    defaultAgent: "kiro",
    windowBlock: null,
    selection: { block: null, conversation: "local/main" },
    select: () => {},
    attentionCount: { inFocus: 0, elsewhere: 0 },
    showsInterrupts: () => true,
    entry: () => undefined,
    depthOf: () => 0,
    register: () => {},
    move: () => {},
    toggleFocus: () => {},
    leaveFocus: () => {},
    branch: () => {},
    threadOf: () => undefined,
    resolving: new Set(),
    mapHead: "",
    mapCell: () => null,
    selectMapCell: () => {},
    open: async () => {},
    ...over,
  } as Workspace;
}

export function inWorkspace(ws: Workspace, ui: ReactElement): ReactElement {
  return <WorkspaceContext.Provider value={ws}>{ui}</WorkspaceContext.Provider>;
}

/** Puts a stand-in bridge on `window`, with only what a test gives it. */
export function bridge(draft: Partial<DraftBridge>): void {
  (window as unknown as { draft: Partial<DraftBridge> }).draft = {
    setMapVisible: () => {},
    setVisible: () => {},
    onChange: () => () => {},
    ensureBlocks: async () => {},
    ...draft,
  };
}
