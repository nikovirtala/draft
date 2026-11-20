import { checkView } from "@nikovirtala/draft-core/view";
import { useEffect } from "react";
import type { Placement, Stub } from "../../../shared/ipc.ts";
import { StatusStub } from "./StatusStub.tsx";

export interface ViewContext {
  stubs: Record<string, Stub>;
  placements: Record<string, Placement>;
  onPlace: (key: string, p: Placement) => void;
  from: string;
  snapshot?: Record<string, unknown>;
}

/**
 * Renders one view description from the fixed component set, after checking it with Zod. An
 * invalid description is shown as plain text and counted: the signal that a component is missing.
 */
export function ViewBlock({
  description,
  context,
}: {
  description: unknown;
  context: ViewContext;
}) {
  const checked = checkView(description);
  const invalid = checked.ok
    ? null
    : typeof description === "string" && !looksLikeJson(description)
      ? "not-json"
      : "schema";
  useEffect(() => {
    if (invalid !== null) window.draft.reportInvalidView(invalid);
  }, [invalid]);

  if (!checked.ok) {
    return (
      <pre className="fallback" data-testid="view-fallback" title={checked.reason}>
        {checked.fallback}
      </pre>
    );
  }
  const view = checked.view;
  switch (view.component) {
    case "text":
      return <p className="view-text">{view.text}</p>;
    case "status-stub": {
      const key = `${view.target.type}:${view.target.id}`;
      const placementKey = `${context.from}#${key}`;
      return (
        <StatusStub
          target={view.target}
          stub={context.stubs[key]}
          snapshot={context.snapshot}
          placement={context.placements[placementKey] ?? "minimized"}
          onPlace={(p) => context.onPlace(placementKey, p)}
        />
      );
    }
  }
}

function looksLikeJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
