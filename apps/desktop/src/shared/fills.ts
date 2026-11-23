import type { Token } from "./palette.ts";

/**
 * Where a fill may appear: the allow-list of docs/design/draft-design-spec.md, "Where things may
 * appear", A1, as a table the e2e harness reads (e2e/design-checks.ts) and a unit test keeps equal
 * to the spec's own table (test/design-rules.test.ts).
 *
 * An element that carries a fill has `data-fill="<place>"` in the markup (a space-separated list
 * when it carries two: a chosen option that is also under the pointer), and the harness fails an
 * element whose computed fill is not allowed by one of its places.
 */

/** The colours that are fills of a state or a selection: the ones a place has to allow. */
export const FILL_TOKENS: readonly Token[] = [
  "--moved-fill",
  "--moved-selected",
  "--done-fill",
  "--review-fill",
  "--waiting-fill",
];

export type Place = "chosen" | "action" | "pointer" | "chip" | "cell" | "notice" | "ask";

export const FILL_PLACES: Readonly<Record<Place, { tokens: readonly Token[]; what: string }>> = {
  chosen: {
    tokens: ["--moved-selected"],
    what: "the chosen option of a list or a control: the current context, the on option of a switch, the chosen map cell",
  },
  action: {
    tokens: ["--moved-selected"],
    what: "the main action button: Send, Allow, Passed, Accept, Switch (disabled, it is paler, not another colour)",
  },
  pointer: {
    tokens: ["--moved-fill"],
    what: "a row or control under the pointer (:hover)",
  },
  chip: {
    tokens: ["--moved-fill", "--done-fill", "--review-fill", "--waiting-fill"],
    what: "a state chip, in the fill of its meaning",
  },
  cell: {
    tokens: ["--moved-fill", "--done-fill", "--waiting-fill"],
    what: "a map cell or a disc of the graph, in the fill of its state",
  },
  notice: {
    tokens: ["--waiting-fill"],
    what: "a failure notice",
  },
  ask: {
    tokens: ["--waiting-fill"],
    what: "a block that asks the person for something: a permission prompt, a proposal, an interrupt, a check",
  },
};

/** The ground the title bar may take, and the only element that may take it. */
export const TITLEBAR = { token: "--titlebar" as Token, selector: "header.titlebar" };

/**
 * The elements a fill may sit under the pointer on (A3): a `:hover` rule that sets a fill must
 * select one of these, with any state or class after it (`.map-range label.on:hover`).
 */
export const POINTER_SELECTORS: readonly string[] = [
  "button.icon",
  ".branch-agent",
  ".attention-open",
  ".context-item-button",
  ".map-range label",
  ".panel-divider",
  ".graph-node",
];
