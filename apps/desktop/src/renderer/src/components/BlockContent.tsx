import type { Entry } from "../../../shared/placement.ts";
import { useWorkspace, type Workspace } from "../workspace.tsx";
import { BlockControls } from "./Icons.tsx";
import { StatusBlock, type StatusProps } from "./StatusStub.tsx";
import { ThreadView } from "./ThreadView.tsx";

/** The content of a status block: its target and the snapshot taken where it was mentioned. */
function statusProps(ws: Workspace, entry: Entry): StatusProps | null {
  const [from, target] = entry.info.address.split("#");
  if (from === undefined || target === undefined) return null;
  const [type, ...rest] = target.split(":");
  const id = rest.join(":");
  const state = ws.states[entry.info.home];
  const ref = state?.messages
    .find((m) => m.address === from)
    ?.references.find((r) => r.target === target);
  return {
    from,
    conversation: entry.info.home,
    target: { type: type as string, id },
    stub: ws.stubs[target],
    snapshot: ref?.snapshot,
  };
}

/**
 * A block in full, whichever kind it is: the panel and a window both show this. A kind this
 * build doesn't know shows its title and its icons, so nothing is lost.
 */
export function BlockContent({ entry }: { entry: Entry }) {
  const ws = useWorkspace();
  switch (entry.info.kind) {
    case "thread":
      return <ThreadView entry={entry} />;
    case "status": {
      const p = statusProps(ws, entry);
      if (p !== null) return <StatusBlock entry={entry} p={p} />;
      break;
    }
  }
  return (
    <section className="block-full generic" data-testid="block-full" data-kind={entry.info.kind}>
      <header className="block-header">
        <div className="stub-line">
          <span className="stub-title">{entry.info.title}</span>
          <span className="spacer" />
          <BlockControls entry={entry} />
        </div>
      </header>
      <p className="secondary">This build doesn’t know how to show a “{entry.info.kind}” block.</p>
    </section>
  );
}
