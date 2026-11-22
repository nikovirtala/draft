import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ContextEntry, ContextPaths } from "./registry.ts";

/** Where a context's agent works, and what it is told about it. */
export interface AgentPlace {
  /** The working directory of the agent process and of every session it starts. */
  cwd: string;
  /** The trusted folder, when the agent works in it. */
  folder: { name: string; path: string } | null;
  /** A folder was trusted once but isn't there now, so the agent stays in its own workspace. */
  missing: boolean;
}

/**
 * The agent works in the folder a person trusted for the context (ADR 1vey5j12). Without one, or
 * when the folder is gone, it stays in the context's own workspace, as before contexts existed.
 */
export function agentPlace(
  entry: Pick<ContextEntry, "folder">,
  paths: Pick<ContextPaths, "agentWorkspace">,
): AgentPlace {
  if (entry.folder !== null) {
    if (isFolder(entry.folder))
      return {
        cwd: entry.folder,
        folder: { name: basename(entry.folder), path: entry.folder },
        missing: false,
      };
    return { cwd: paths.agentWorkspace, folder: null, missing: true };
  }
  return { cwd: paths.agentWorkspace, folder: null, missing: false };
}

function isFolder(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** What the agent is told about where it is: the folder's name, never its path. */
export function placeBriefing(place: AgentPlace): string | null {
  if (place.folder === null) return null;
  return `Your working directory is the project folder "${place.folder.name}", which the user trusted for this context. The tools named above are the only ones you have there, and anything that changes something asks the user first.`;
}
