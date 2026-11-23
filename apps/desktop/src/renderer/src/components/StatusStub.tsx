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

/** What a stub says about its target, whatever the target is. */
interface Chip {
  text: string;
  testid: string;
  tone?: "bad" | "good" | "wait" | "review";
}

interface Summary {
  state: Record<string, unknown>;
  /** A stable word for styling and tests. */
  status: string;
  statusLabel: string;
  title: string;
  /** The reference, shown beside the title in mono: `repo#12`. */
  ref?: string;
  chips: Chip[];
  kind: string;
  details: [string, string][];
  url: string | null;
}

const KINDS: Record<string, string> = {
  "kiro-session": "Kiro session",
  "pull-request": "Pull request",
  "ark-issue": "ark issue",
  adr: "ADR",
  artifact: "Artifact page",
};

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function pullRequest(state: Record<string, unknown>, id: string): Summary {
  const sum = (state.checksSummary ?? {}) as Record<string, number>;
  const review = (state.review ?? {}) as { decision?: string };
  const chips: Chip[] = [];
  if ((sum.failed ?? 0) > 0)
    chips.push({ text: `${sum.failed} failing`, testid: "stub-checks", tone: "bad" });
  else if ((sum.pending ?? 0) > 0)
    chips.push({ text: `${sum.pending} running`, testid: "stub-checks", tone: "review" });
  else if ((sum.total ?? 0) > 0)
    chips.push({
      text: `${sum.passed}/${sum.total} checks passed`,
      testid: "stub-checks",
      tone: "good",
    });
  if (state.mergeableState === "dirty")
    chips.push({ text: "Merge conflict", testid: "stub-mergeable", tone: "bad" });
  if (review.decision === "changes_requested")
    chips.push({ text: "Changes requested", testid: "stub-review", tone: "bad" });
  else if (review.decision === "approved")
    chips.push({ text: "Approved", testid: "stub-review", tone: "good" });
  if (state.viewerReviewRequested === true)
    chips.push({ text: "Your review", testid: "stub-review-requested", tone: "wait" });
  const st = str(state.state) ?? "unknown";
  const repo = str(state.repo) ?? id;
  return {
    state,
    status: st,
    statusLabel: `${state.draft === true ? "Draft · " : ""}${st[0]?.toUpperCase() ?? ""}${st.slice(1)}`,
    title: `${repo}#${num(state.number) ?? ""} ${str(state.title) ?? ""}`.trim(),
    ref: `${repo}#${num(state.number) ?? ""}`,
    chips,
    kind: KINDS["pull-request"] as string,
    url: str(state.url),
    details: [
      ["Pull request", id],
      ["Head", (str(state.headSha) ?? "").slice(0, 8)],
      ["Mergeable", str(state.mergeableState) ?? "unknown"],
      [
        "Checks",
        `${sum.passed ?? 0} passed, ${sum.failed ?? 0} failed, ${sum.pending ?? 0} running`,
      ],
      ["Review", review.decision ?? "none"],
    ],
  };
}

function arkIssue(state: Record<string, unknown>, id: string): Summary {
  const st = str(state.status) ?? "unknown";
  const res = str(state.resolution);
  return {
    state,
    status: st,
    statusLabel:
      st === "closed" && res !== null
        ? `Closed: ${res}`
        : st === "in-progress"
          ? "In progress"
          : st[0]?.toUpperCase() + st.slice(1),
    title: str(state.title) ?? id,
    chips: [{ text: `${num(state.eventCount) ?? 0} events`, testid: "stub-events" }],
    kind: KINDS["ark-issue"] as string,
    url: str(state.url),
    details: [
      ["Issue", id],
      ["Last event", String((state.events as { type: string }[] | undefined)?.at(-1)?.type ?? "")],
    ],
  };
}

function adr(state: Record<string, unknown>, id: string): Summary {
  const st = str(state.status) ?? "unknown";
  const by = (state.proposedBy ?? null) as {
    number?: number;
    headRef?: string;
    state?: string;
  } | null;
  const verify = (state.verify ?? null) as { status?: string } | null;
  const chips: Chip[] = [];
  if (by !== null && by.number !== undefined)
    chips.push({ text: `#${by.number} proposes it`, testid: "stub-proposed-by" });
  if (st === "proposed" && verify !== null)
    chips.push({
      text: verify.status === "clean" ? "adr verify clean" : "adr verify has findings",
      testid: "stub-verify",
      tone: verify.status === "clean" ? "good" : "bad",
    });
  return {
    state,
    status: st,
    statusLabel: st[0]?.toUpperCase() + st.slice(1),
    title: str(state.title) ?? id,
    chips,
    kind: KINDS.adr as string,
    url: str(state.url),
    details: [
      ["ADR", id],
      ["Last event", String((state.events as { type: string }[] | undefined)?.at(-1)?.type ?? "")],
      ...(by !== null && by.headRef !== undefined
        ? ([["Branch", by.headRef]] as [string, string][])
        : []),
    ],
  };
}

function artifact(state: Record<string, unknown>, id: string): Summary {
  const v = num(state.currentVersion);
  return {
    state,
    status: "published",
    statusLabel: v === null ? "Published" : `Version ${v}`,
    title: str(state.title) ?? id,
    chips: [],
    kind: KINDS.artifact as string,
    url: str(state.url),
    details: [
      ["Artifact", id],
      ["Versions", String(num(state.versions) ?? "")],
      ["Updated", str(state.updatedAt) ?? ""],
    ],
  };
}

function kiroSession(state: Record<string, unknown>, id: string): Summary {
  const status = typeof state.status === "string" ? state.status : "unknown";
  const pending = num(state.pendingPermissions) ?? 0;
  return {
    state,
    status,
    statusLabel: label(status),
    title: str(state.title) ?? "Untitled session",
    chips:
      pending > 0 ? [{ text: pendingText(pending), testid: "stub-pending", tone: "wait" }] : [],
    kind: KINDS["kiro-session"] as string,
    url: null,
    details: [
      ["Session", id],
      ...(Array.isArray(state.repos) && state.repos.length > 0
        ? ([["Repositories", (state.repos as string[]).join(", ")]] as [string, string][])
        : []),
    ],
  };
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

function summary(p: StatusProps): Summary {
  const state = p.stub?.state ?? p.snapshot ?? {};
  switch (p.target.type) {
    case "pull-request":
      return pullRequest(state, p.target.id);
    case "ark-issue":
      return arkIssue(state, p.target.id);
    case "adr":
      return adr(state, p.target.id);
    case "artifact":
      return artifact(state, p.target.id);
    default:
      return kiroSession(state, p.target.id);
  }
}

function Details({ p, s }: { p: StatusProps; s: Summary }) {
  const then = p.snapshot === undefined ? null : summary({ ...p, stub: undefined }).statusLabel;
  return (
    <dl className="stub-details" data-testid="stub-details">
      {s.details.map(([k, v]) => (
        <div className="stub-detail" key={k}>
          <dt>{k}</dt>
          <dd>
            {k === "Session" ||
            k === "Pull request" ||
            k === "Issue" ||
            k === "ADR" ||
            k === "Artifact" ? (
              <code>{v}</code>
            ) : (
              v
            )}
          </dd>
        </div>
      ))}
      {then !== null && (
        <div className="stub-detail">
          <dt>When mentioned</dt>
          <dd>{then}</dd>
        </div>
      )}
      {s.url !== null && (
        <div className="stub-detail">
          <dt>Link</dt>
          <dd>
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.url}
            </a>
          </dd>
        </div>
      )}
      {p.stub !== undefined && (
        <div className="stub-detail">
          <dt>Last seen</dt>
          <dd>{new Date(p.stub.observedAt).toLocaleTimeString()}</dd>
        </div>
      )}
    </dl>
  );
}

function Line({ p, children }: { p: StatusProps; children?: React.ReactNode }) {
  const s = summary(p);
  return (
    <div className="stub-line">
      <span className="dot" aria-hidden="true" />
      <span className="stub-title">
        {s.ref !== undefined && s.title.startsWith(s.ref) ? (
          <>
            <code className="stub-ref">{s.ref}</code>
            {s.title.slice(s.ref.length)}
          </>
        ) : (
          s.title
        )}
      </span>
      <span
        className={`stub-status${s.kind === KINDS["pull-request"] ? ` pr-state pr-${s.status}` : ""}`}
        data-testid="stub-status"
        data-state={s.status}
      >
        {s.statusLabel}
      </span>
      {s.chips.map((c) => (
        <span key={c.testid} className={`pending ${c.tone ?? ""}`} data-testid={c.testid}>
          {c.text}
        </span>
      ))}
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
  const sum = summary(p);
  const { status, title } = sum;
  const depth = ws.depthOf(p.conversation);
  const entry = ws.entry(address);
  const snapshotTitle = p.snapshot === undefined ? null : summary({ ...p, stub: undefined }).title;
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
      aria-label={`${sum.kind} ${title}`}
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
      {expanded && <Details p={p} s={sum} />}
    </section>
  );
}

/** A Kiro session in full, in the panel or its own window. */
export function StatusBlock({ entry, p }: { entry: Entry; p: StatusProps }) {
  const sum = summary(p);
  const { status, title } = sum;
  const selectable = useSelectable(entry.info.address, p.conversation);
  return (
    <section
      {...selectable}
      className={`block-full status-${status}`}
      data-testid="block-full"
      data-block={entry.info.address}
      data-kind="status"
      data-stub-target={`${p.target.type}:${p.target.id}`}
      aria-label={`${sum.kind} ${title}`}
    >
      <header className="block-header">
        <Line p={p}>{availableMoves(entry).length > 0 && <BlockControls entry={entry} />}</Line>
      </header>
      <Details p={p} s={sum} />
    </section>
  );
}
