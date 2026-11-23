import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The named states of the screenshot comment: the state's name, the screenshot an end-to-end spec
 * takes of it (a `shot` or `shotOf` call in e2e/), and the design system's preview it should look
 * like, with the width to render that preview at. The list is e2e/states.json; the workflow reads
 * it through the scripts here and never spells a state out.
 */
export interface State {
  state: string;
  /** The file in e2e/artifacts, `<name>.png`. */
  screenshot: string;
  /** The preview's path from the repository root, or null when the design has none. */
  preview: string | null;
  /** The width, in pixels, to render the preview at. */
  width: number;
}

export const STATES_FILE = fileURLToPath(new URL("../e2e/states.json", import.meta.url));

export const loadStates = (file: string = STATES_FILE): State[] =>
  JSON.parse(readFileSync(file, "utf8")) as State[];

/** The file the rendered preview of a state is written to, beside its screenshot's name. */
export const previewFile = (s: State): string => s.screenshot.replace(/\.png$/, ".preview.png");
