import { useEffect, useState } from "react";
import type { Boot } from "../../shared/ipc.ts";
import { windowTitle } from "../../shared/placement.ts";
import { AgentEnvironment, AgentState, agentLabel } from "./components/AgentState.tsx";
import { AttentionBar } from "./components/AttentionBar.tsx";
import { BlockContent } from "./components/BlockContent.tsx";
import { ContextBar } from "./components/ContextBar.tsx";
import { ConversationView } from "./components/ConversationView.tsx";
import { TrustStep } from "./components/TrustStep.tsx";
import { useVisibleStubs } from "./visibility.ts";
import { panelEntry, useWorkspace, type Workspace, WorkspaceProvider } from "./workspace.tsx";

type Ready = Extract<Boot, { kind: "ready" }>;

/** The gestures: Ctrl or Cmd with a period enters focus on what is selected, and leaves it; Esc leaves. */
function useFocusGesture(ws: Workspace) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ws.view.layout.focus !== null) {
        e.preventDefault();
        ws.leaveFocus();
      } else if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        ws.toggleFocus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws]);
}

function MainWindow() {
  const ws = useWorkspace();
  useFocusGesture(ws);
  useVisibleStubs();
  const main = ws.states[ws.main];
  const panel = panelEntry(ws);
  return (
    <div className="app" data-testid="app" data-focused={ws.view.layout.focus !== null}>
      <header className="titlebar">
        <span className="brand">draft</span>
        <ContextBar />
        <span className="title">{main?.title ?? ""}</span>
        {main !== undefined && (
          <AgentState
            agent={main.agent}
            onChange={(s) => void window.draft.setAgentState(ws.main, s)}
          />
        )}
        <span className="spacer" />
        <AttentionBar />
      </header>
      {main?.agent.environment != null && <AgentEnvironment environment={main.agent.environment} />}
      <div className={`workspace${panel === null ? "" : " with-panel"}`}>
        <section className="left" aria-label="Conversation">
          <ConversationView conversation={ws.main} />
        </section>
        {panel !== null && (
          <aside className="panel" data-testid="panel" aria-label="Panel">
            <BlockContent key={panel.info.address} entry={panel} />
          </aside>
        )}
      </div>
    </div>
  );
}

/** A window that shows one block in full, titled with what it is and where it came from. */
function BlockWindow({ block }: { block: string }) {
  const ws = useWorkspace();
  useFocusGesture(ws);
  useVisibleStubs();
  const entry = ws.entry(block);
  const origin = entry === undefined ? null : (ws.threadOf(entry.info.home)?.title ?? null);
  useEffect(() => {
    if (entry !== undefined) document.title = windowTitle(entry.info, origin);
  }, [entry, origin]);
  return (
    <div className="app window-app" data-testid="window" data-block={block}>
      <header className="titlebar window-bar">
        <span className="title" data-testid="window-title">
          {entry === undefined ? "" : windowTitle(entry.info, origin)}
        </span>
        <span className="spacer" />
        <AttentionBar />
      </header>
      {entry === undefined || entry.placement !== "window" ? null : <BlockContent entry={entry} />}
    </div>
  );
}

function Shell({ boot }: { boot: Ready }) {
  return (
    <WorkspaceProvider boot={boot}>
      {boot.block === null ? <MainWindow /> : <BlockWindow block={boot.block} />}
    </WorkspaceProvider>
  );
}

export function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const load = () => void window.draft.boot().then(setBoot);
  useEffect(load, []);
  if (boot?.kind === "trust") return <TrustStep question={boot.question} onAnswered={load} />;

  if (boot?.kind === "refused") {
    return (
      <div className="app">
        <header className="titlebar">
          <span className="brand">draft</span>
        </header>
        <main className="refused" data-testid="refused">
          <h1>draft won’t open this log</h1>
          <p>
            The log’s hash chain doesn’t verify, so its history may have been changed. Nothing was
            read from it.
          </p>
          <pre>{boot.reason}</pre>
          <p className="secondary">
            Restore the file from a backup, or move it aside to start a new log: {boot.path}
          </p>
        </main>
      </div>
    );
  }
  if (boot === null) return <div className="app" />;
  return <Shell boot={boot} />;
}

export { agentLabel };
