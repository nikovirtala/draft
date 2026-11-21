import { isAbsolute, resolve } from "node:path";
import type { ContextIntent } from "@nikovirtala/draft-core";
import { expandHome } from "./folder.ts";

/** What a launch of draft asks for: folders to open as contexts and data directories to import. */
export interface LaunchRequest {
  folders: string[];
  imports: string[];
}

export const NO_REQUEST: LaunchRequest = { folders: [], imports: [] };

/**
 * Reads the command line of a launch: `draft <folder>…` and `draft --import <data-dir>`. `argv` is
 * Electron's `process.argv`, or the one a second launch hands to the running app, where
 * `defaultApp` says the app was started as `electron <app path> …` (the dev script and the tests)
 * and so has its app path before the arguments. Relative paths are taken from `cwd`, the folder
 * the launch happened in. Other `--flags` belong to Chromium and are ignored. Whether a path
 * exists is for the caller to find out.
 */
export function parseLaunchArgs(
  argv: readonly string[],
  cwd: string,
  o: { defaultApp?: boolean; home?: string } = {},
): LaunchRequest {
  const args = argv.slice(o.defaultApp === true ? 2 : 1);
  const abs = (p: string) => {
    const expanded = expandHome(p, o.home);
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  };
  const folders: string[] = [];
  const imports: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--import") {
      const next = args[++i];
      if (next !== undefined) imports.push(abs(next));
    } else if (a.startsWith("--import=")) {
      imports.push(abs(a.slice("--import=".length)));
    } else if (a === "--") {
    } else if (!a.startsWith("-") && a !== "") {
      folders.push(abs(a));
    }
  }
  return { folders: [...new Set(folders)], imports: [...new Set(imports)] };
}

export function isEmptyRequest(r: LaunchRequest): boolean {
  return r.folders.length === 0 && r.imports.length === 0;
}

const FOLDER = String.raw`("[^"]+"|'[^']+'|(?:~|\.{1,2}|/|[A-Za-z]:[\\/])\S*(?:\s\S+)*?)`;
const OPEN_NAME =
  /^(?:please\s+)?(?:open|switch to)\s+(?:the\s+)?(?:context\s+)?([0-9a-z][0-9a-z-]*)\s*[.!]?$/i;
const NEW_CONTEXT = new RegExp(
  String.raw`^(?:please\s+)?(?:new|create(?:\s+a)?(?:\s+new)?)\s+context\s+(?:for|in|at|from|on)\s+${FOLDER}\s*[.!]?$`,
  "i",
);

/**
 * The sentences that ask to open a context: "open longplay" for a context on this device and
 * "new context for ~/code/x" for a folder. Anything else is for the agent. Recognizing it is
 * draft's own work, with no model: the sentence only becomes a proposal that a person confirms.
 */
export function recogniseSentence(text: string, names: readonly string[]): ContextIntent | null {
  const t = text.trim();
  const open = OPEN_NAME.exec(t);
  if (open !== null) {
    const name = (open[1] as string).toLowerCase();
    return names.includes(name) ? { kind: "open", name } : null;
  }
  const made = NEW_CONTEXT.exec(t);
  if (made !== null) {
    const folder = (made[1] as string).replace(/^(["'])(.*)\1$/, "$2").trim();
    return folder === "" ? null : { kind: "new", folder };
  }
  return null;
}
