import { useEffect, useState } from "react";
import { useWorkspace } from "../workspace.tsx";

/**
 * How long work has to last before the indicator shows. Work that ends sooner never flickers on
 * screen. One constant for every place the indicator is used.
 */
export const WORKING_DELAY_MS = 500;

/** Where the indicator is shown; it looks the same in each. */
export type WorkPlace = "turn" | "stub" | "map" | "context" | "global";

/** Whether `active` has held for `delayMs`. False the moment it stops. */
export function useAfterDelay(active: boolean, delayMs: number = WORKING_DELAY_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && elapsed;
}

/**
 * The one indicator that draft is working: a purple ring turning, the colour of the agent's
 * activity. It shows `WORKING_DELAY_MS` after the work starts and only while it lasts, and says in
 * words what is going on: to a screen reader always, to everyone when `showLabel` is set.
 */
export function Working({
  active,
  label,
  place,
  showLabel = false,
  className = "",
}: {
  active: boolean;
  /** What is going on, in words: "Kiro is working", "Reading GitHub". */
  label: string;
  place: WorkPlace;
  showLabel?: boolean;
  className?: string;
}) {
  const shown = useAfterDelay(active);
  if (!shown) return null;
  return (
    <span
      className={`working ${className}`.trim()}
      role="status"
      title={label}
      data-testid="working"
      data-place={place}
    >
      <span className="working-ring" aria-hidden="true" />
      <span className={showLabel ? "working-label" : "visually-hidden"}>{label}</span>
    </span>
  );
}

/** What is going on that no block of its own shows: said once, in words. */
export function workingLabel(turns: number, stubs: number): string {
  const parts: string[] = [];
  if (turns > 0) parts.push(turns === 1 ? "An agent is working" : `${turns} agents are working`);
  if (stubs > 0) parts.push(stubs === 1 ? "Reading 1 status" : `Reading ${stubs} statuses`);
  return parts.join(" · ");
}

/**
 * The quiet global place: work anywhere in this window, whether or not its own block is on
 * screen. It sits beside the agent's state until the footer has a place for it.
 */
export function GlobalWorking() {
  const ws = useWorkspace();
  const turns = Object.values(ws.states).filter((s) => s.busy).length;
  const stubs = ws.resolving.size;
  return (
    <Working
      active={turns + stubs > 0}
      label={workingLabel(turns, stubs)}
      place="global"
      className="global-working"
    />
  );
}
