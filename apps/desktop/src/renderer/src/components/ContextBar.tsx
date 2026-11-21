import { useEffect, useRef, useState } from "react";
import type { ContextListItem } from "../../../shared/ipc.ts";
import { useWorkspace } from "../workspace.tsx";

/** How long ago, in the words the recent list uses. */
function ago(at: string | null): string {
  if (at === null) return "no activity yet";
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/**
 * Which context this window is, where its agent works, and a short list of the others: reachable
 * from the conversation without leaving it. Opening one gives it a window of its own.
 */
export function ContextBar() {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ContextListItem[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    void window.draft.contexts().then(setItems);
    const close = (e: MouseEvent) => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const { context } = ws;
  return (
    <div className="context-bar" ref={box} data-testid="context-bar">
      <span className="context-name" data-testid="context-name">
        {context.name}
      </span>
      {context.folder !== null && (
        <span className="context-folder" data-testid="context-folder" title={context.folder.path}>
          {context.folder.name}
        </span>
      )}
      {context.folderMissing && (
        <span className="context-folder missing" data-testid="context-folder-missing">
          folder not found
        </span>
      )}
      <button
        type="button"
        className="contexts-button"
        data-testid="contexts-button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Contexts ▾
      </button>
      {open && (
        <div className="contexts-list" data-testid="contexts-list" role="menu">
          <ul>
            {items.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  role="menuitem"
                  className="context-item-button"
                  data-testid="context-recent"
                  data-context={c.name}
                  data-current={c.current}
                  onClick={() => {
                    setOpen(false);
                    if (!c.current) void window.draft.openContext(c.name);
                  }}
                >
                  <span className="context-recent-name">{c.name}</span>
                  <span className="context-recent-meta secondary">
                    {c.folder ?? "own workspace"} · {ago(c.lastActivity)}
                    {c.open ? " · open" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="contexts-actions">
            <button
              type="button"
              className="secondary-button"
              data-testid="open-folder"
              onClick={() => {
                setOpen(false);
                void window.draft.chooseFolder();
              }}
            >
              Open a folder…
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="import-data-dir"
              onClick={() => {
                setOpen(false);
                void window.draft.chooseImport();
              }}
            >
              Import a data directory…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
