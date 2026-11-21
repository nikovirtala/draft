import { checkView } from "@nikovirtala/draft-core/view";
import { useEffect } from "react";
import type { Stub } from "../../../shared/ipc.ts";
import { StatusStub } from "./StatusStub.tsx";

export interface ViewContext {
  stubs: Record<string, Stub>;
  /** The message that shows the view. */
  from: string;
  /** The conversation that message is in. */
  conversation: string;
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
    case "status-stub":
      return (
        <StatusStub
          from={context.from}
          conversation={context.conversation}
          target={view.target}
          stub={context.stubs[`${view.target.type}:${view.target.id}`]}
          snapshot={context.snapshot}
        />
      );
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
