import type { InterruptCause } from "./ipc.ts";

/** What each kind of thing that needs a person is called, in lists and on the title bar. */
export const CAUSE_LABELS: Record<InterruptCause, string> = {
  permission: "Permission request",
  "failed-check": "Failed check",
  "merge-conflict": "Merge conflict",
  "changes-requested": "Changes requested",
  "failed-step": "Failed step",
  "unasked-call": "Call without asking",
  "unfinished-step": "Interrupted step",
  conclusion: "Conclusion to confirm",
  "review-requested": "Review requested",
  acceptance: "Ready for you to accept",
};

/** The words on the button for each way to settle something. */
export const OUTCOME_LABELS: Record<string, string> = {
  allowed: "Allow",
  denied: "Deny",
  done: "It happened",
  failed: "It didn’t happen",
  retry: "Run it again as a new step",
  acknowledged: "I’ve seen it",
};

/** What a settled interrupt says it was settled as. */
export const SETTLED_LABELS: Record<string, string> = {
  allowed: "Allowed",
  denied: "Denied",
  done: "Marked as done",
  failed: "Marked as failed",
  retry: "Run again as a new step",
  acknowledged: "Seen",
};

/** How long something has waited, from the time it arose: "just now", "3 min", "2 h", "1 d". */
export function ageText(at: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
