import { createHash } from "node:crypto";
import {
  copyFileSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { readLogRecords } from "@nikovirtala/draft-core";
import { type ContextEntry, type ContextRegistry, pathsOf } from "./registry.ts";

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportResult {
  entry: ContextEntry;
  /** False when this data directory was imported before: the context is the one made then. */
  created: boolean;
  /**
   * The folder the old setup's `agent-workspace` symbolic link pointed at. It is only offered:
   * binding it goes through the trust step like any folder.
   */
  folder: string | null;
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The folder a data directory's `agent-workspace` links to, when it is a symbolic link to one. */
export function workspaceLink(dir: string): string | null {
  const link = join(dir, "agent-workspace");
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    const target = realpathSync(link);
    return statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

/**
 * Imports a `DRAFT_DATA_DIR` setup as a context: its log is copied, byte for byte, into a new
 * context's directory and the copy is checked against the original. The original is only read:
 * nothing in the old directory changes, and a log that doesn't verify is refused. The log's own
 * addresses keep the context name they were written with (ADR 17gtag9n).
 */
export function importDataDir(
  registry: ContextRegistry,
  dataDir: string,
  input: string,
): ImportResult {
  let dir: string;
  try {
    dir = realpathSync(input);
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ImportError(`${input} isn't a folder`);
  }
  const own = realpathSync(dataDir);
  if (dir === own || dir.startsWith(`${own}/`))
    throw new ImportError("that is draft's own data directory here, not another setup");
  const source = join(dir, "log.jsonl");
  try {
    statSync(source);
  } catch {
    throw new ImportError(`${dir} has no log.jsonl: it isn't a draft data directory`);
  }
  const existing = registry.byImport(dir);
  const folder = workspaceLink(dir);
  if (existing !== null) return { entry: existing, created: false, folder };

  const read = readLogRecords(source);
  if (!read.ok)
    throw new ImportError(
      `the log doesn't verify (event ${read.index + 1} ${read.reason}), so draft won't import it`,
    );
  const first = read.events[0];
  const firstAddress = first !== undefined && "address" in first ? first.address : "";
  const logContext = firstAddress.split(/[/@]/, 1)[0] ?? "";

  const name = registry.uniqueName(basename(folder ?? dir));
  const entry = registry.create({
    name,
    title: name,
    logContext: logContext === "" ? name : logContext,
    importedFrom: dir,
  });
  const dest = pathsOf(dataDir, entry).log;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest, fsConstants.COPYFILE_EXCL);
  if (sha256(dest) !== sha256(source))
    throw new ImportError("the copy of the log differs from the original, so it was not used");
  const last = read.events.at(-1);
  registry.touch(name, last !== undefined && typeof last.at === "string" ? last.at : undefined);
  registry.flush();
  return { entry, created: true, folder };
}
