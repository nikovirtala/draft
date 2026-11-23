/**
 * What a window shows of a check. Plain data and no imports, so the renderer can share the types
 * without reaching into the log (as map-types.ts does for the map).
 */

export type CheckState = "requested" | "passed" | "failed";

export interface UiCheckStep {
  text: string;
  do: string;
  see: string | null;
  commands: string[];
}

/** What asked for a check; a merged pull request is the first source. */
export interface UiCheckSource {
  type: "merged-pull-request";
  target: { type: string; id: string };
  ref: string;
  sha: string;
  title: string | null;
  url: string | null;
}

export interface UiCheck {
  key: string;
  state: CheckState;
  title: string;
  reason: string;
  steps: UiCheckStep[];
  tail: string | null;
  raw: string;
  parsed: boolean;
  source: UiCheckSource;
  /** The proposed decisions it is about: passing it offers their acceptance. */
  gates: { target: { type: string; id: string }; title: string | null }[];
  requestedAt: string;
  /** When it last asked for the person: the request, or its latest reminder. */
  raisedAt: string;
  reminders: number;
  answer: { outcome: "passed" | "failed"; at: string; by: string; note: string | null } | null;
}
