import type { Placement, Stub } from "../../../shared/ipc.ts";

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

const ExpandIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path
      d="M4 6l4 4 4-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const MinimizeIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path
      d="M4 10l4-4 4 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * A live Kiro session: one line when minimized (title, status, pending permissions), the details
 * when expanded inline. Expand and minimize are its only icons in this slice.
 */
export function StatusStub({
  target,
  stub,
  snapshot,
  placement,
  onPlace,
}: {
  target: { type: string; id: string };
  stub: Stub | undefined;
  snapshot: Record<string, unknown> | undefined;
  placement: Placement;
  onPlace: (p: Placement) => void;
}) {
  const state = stub?.state ?? snapshot ?? {};
  const status = typeof state.status === "string" ? state.status : "unknown";
  const pending = typeof state.pendingPermissions === "number" ? state.pendingPermissions : 0;
  const title =
    typeof state.title === "string" && state.title !== "" ? state.title : "Untitled session";
  const expanded = placement === "inline";
  const thenStatus = snapshot?.status;
  return (
    <section
      className={`stub status-${status} ${expanded ? "expanded" : "minimized"}`}
      data-testid="stub"
      data-stub-target={`${target.type}:${target.id}`}
      data-status={status}
      aria-label={`Kiro session ${title}`}
    >
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
        <button
          type="button"
          className="icon"
          aria-label={expanded ? "Minimize" : "Expand"}
          title={expanded ? "Minimize" : "Expand"}
          onClick={() => onPlace(expanded ? "minimized" : "inline")}
        >
          {expanded ? <MinimizeIcon /> : <ExpandIcon />}
        </button>
      </div>
      {expanded && (
        <dl className="stub-details" data-testid="stub-details">
          <dt>Session</dt>
          <dd>
            <code>{target.id}</code>
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
          {stub !== undefined && (
            <>
              <dt>Last seen</dt>
              <dd>{new Date(stub.observedAt).toLocaleTimeString()}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}
