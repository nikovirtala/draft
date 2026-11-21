import { useEffect } from "react";
import type { Stub } from "../../../shared/ipc.ts";
import { availableMoves, type Entry, type Placement } from "../../../shared/placement.ts";
import { useWorkspace } from "../workspace.tsx";
import { BlockControls } from "./Icons.tsx";
import { useSelectable } from "./selectable.ts";

const LABELS: Record<string, string> = {
  provisioning: "Starting",
  running: "Running",
  idle: "Idle",
  awaiting_permission: "Waiting for you",
  failed: "Failed",
  deleted: "Deleted",
};

function label(status: unknown): string {
  return typeof status === "string" ? (LABELS[status] ?? status) : "Unknown";
}

function pendingText(n: number): string {
  return n === 1 ? "1 permission waiting" : `${n} permissions waiting`;
}

/** The address of the status block a message shows for one target. */
export function statusAddress(message: string, target: { type: string; id: string }): string {
  return `${message}#${target.type}:${target.id}`;
}

export interface StatusProps {
  /** The message that shows it; with the target, its address. */
  from: string;
  /** The conversation that message is in: where the block was created. */
  conversation: string;
  target: { type: string; id: string };
  stub: Stub | undefined;
  snapshot: Record<string, unknown> | undefined;
}

function summary(p: StatusProps) {
  const state = p.stub?.state ?? p.snapshot ?? {};
  const status = typeof state.status === "string" ? state.status : "unknown";
  const pending = typeof state.pendingPermissions === "number" ? state.pendingPermissions : 0;
  const title =
    typeof state.title === "string" && state.title !== "" ? state.title : "Untitled session";
  return { state, status, pending, title };
}

function Details({ p, state }: { p: StatusProps; state: Record<string, unknown> }) {
  const thenStatus = p.snapshot?.status;
  return (
    <dl className="stub-details" data-testid="stub-details">
      <dt>Session</dt>
      <dd>
        <code>{p.target.id}</code>
      </dd>
      {Array.isArray(state.repos) && state.repos.length > 0 && (
        <>
          <dt>Repositories</dt>
          <dd>{(state.repos as string[]).join(", ")}</dd>
        </>
      )}
      {typeof thenStatus === "string" && (
        <>
          <dt>When mentioned</dt>
          <dd>{label(thenStatus)}</dd>
        </>
      )}
      {p.stub !== undefined && (
        <>
          <dt>Last seen</dt>
          <dd>{new Date(p.stub.observedAt).toLocaleTimeString()}</dd>
        </>
      )}
    </dl>
  );
}

function Line({ p, children }: { p: StatusProps; children?: React.ReactNode }) {
  const { status, pending, title } = summary(p);
  return (
    <div className="stub-line">
      <span className="dot" aria-hidden="true" />
      <span className="stub-title">{title}</span>
      <span className="stub-status" data-testid="stub-status">
        {label(status)}
      </span>
      {pending > 0 && (
        <span className="pending" data-testid="stub-pending">
          {pendingText(pending)}
        </span>
      )}
      <span className="spacer" />
      {children}
    </div>
  );
}

const WHERE: Record<string, string> = { panel: "In the panel", window: "In a window" };

/**
 * A live Kiro session where it was made, in the message that mentioned it. Inline it shows its
 * details, minimized one line; moved to the panel or a window it leaves a stub that says where
 * it went. Its icons are the model's table for its placement.
 */
export function StatusStub(p: StatusProps) {
  const ws = useWorkspace();
  const address = statusAddress(p.from, p.target);
  const { state, status, title } = summary(p);
  const depth = ws.depthOf(p.conversation);
  const entry = ws.entry(address);
  const snapshotTitle =
    typeof p.snapshot?.title === "string" && p.snapshot.title !== "" ? p.snapshot.title : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a block is registered once, when it is first seen; its title is fixed then
  useEffect(
    () =>
      ws.register({
        info: {
          address,
          kind: "status",
          home: p.conversation,
          depth,
          opens: null,
          title: snapshotTitle ?? title,
        },
        initial: "minimized",
      }),
    [address],
  );
  const placement: Placement = entry?.placement ?? "minimized";
  const away = placement === "panel" || placement === "window";
  const expanded = placement === "inline";
  const selectable = useSelectable(address, p.conversation);
  return (
    <section
      {...selectable}
      className={`stub status-${status} ${away ? "away" : expanded ? "expanded" : "minimized"}`}
      data-testid="stub"
      data-block={address}
      data-placement={placement}
      data-stub-target={`${p.target.type}:${p.target.id}`}
      data-status={status}
      aria-label={`Kiro session ${title}`}
    >
      <Line p={p}>
        {away ? (
          <span className="where" data-testid="stub-where">
            {WHERE[placement]}
          </span>
        ) : (
          entry !== undefined && <BlockControls entry={entry} />
        )}
      </Line>
      {expanded && <Details p={p} state={state} />}
    </section>
  );
}

/** A Kiro session in full, in the panel or its own window. */
export function StatusBlock({ entry, p }: { entry: Entry; p: StatusProps }) {
  const { status, title } = summary(p);
  const state = summary(p).state;
  const selectable = useSelectable(entry.info.address, p.conversation);
  return (
    <section
      {...selectable}
      className={`block-full status-${status}`}
      data-testid="block-full"
      data-block={entry.info.address}
      data-kind="status"
      data-stub-target={`${p.target.type}:${p.target.id}`}
      aria-label={`Kiro session ${title}`}
    >
      <header className="block-header">
        <Line p={p}>{availableMoves(entry).length > 0 && <BlockControls entry={entry} />}</Line>
      </header>
      <Details p={p} state={state} />
    </section>
  );
}
