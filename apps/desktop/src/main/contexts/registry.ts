import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isSegment } from "@nikovirtala/draft-core";
import { z } from "zod";

/**
 * The device's list of contexts (ADR 17gtag9n): what each is called, where its files are, which
 * folder it is bound to on this device, and when it was last used. It lives in `contexts.json` in
 * the data directory, is written atomically, and is not in any log: a folder's place belongs to
 * the device, so another device reading a log never learns it.
 */

/** The context that was the only one before contexts existed: its files stay where they were. */
export const LOCAL_CONTEXT = "local";

const Name = z.string().refine(isSegment, "not an address segment");

const EntrySchema = z.object({
  name: Name,
  title: z.string().min(1),
  /** What the log's own addresses say. It differs from `name` only for an imported log. */
  logContext: Name,
  /** Where its files are, relative to the data directory; "." for the local context. */
  dir: z.string().min(1),
  /** The real path of the folder a person trusted for it on this device. */
  folder: z.string().min(1).nullable(),
  /** A folder draft asked about and that isn't trusted (declined, or not answered yet). */
  candidate: z.string().min(1).nullable(),
  /** The data directory this context was imported from, so importing it again finds it. */
  importedFrom: z.string().min(1).nullable(),
  createdAt: z.iso.datetime({ precision: 3 }),
  lastActivity: z.iso.datetime({ precision: 3 }).nullable(),
});
export type ContextEntry = z.infer<typeof EntrySchema>;

const FileSchema = z.object({
  version: z.literal(1),
  contexts: z.array(EntrySchema),
  /** The contexts that were open when draft last ended, in the order they opened. */
  open: z.array(Name),
});

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** The files of one context, as absolute paths. */
export interface ContextPaths {
  dir: string;
  log: string;
  views: string;
  device: string;
  /** The agent's own directory, used until a folder is trusted. */
  agentWorkspace: string;
}

export function pathsOf(dataDir: string, entry: Pick<ContextEntry, "dir">): ContextPaths {
  const dir = isAbsolute(entry.dir) ? entry.dir : join(dataDir, entry.dir);
  return {
    dir,
    log: join(dir, "log.jsonl"),
    views: join(dir, "views.db"),
    device: join(dir, "device.db"),
    agentWorkspace: join(dir, "agent-workspace"),
  };
}

/** A folder's name as a context name: lowercase letters, digits and inner hyphens. */
export function slugify(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return isSegment(s) ? s : "context";
}

export class ContextRegistry {
  private readonly file: string;
  private entries: ContextEntry[];
  private openNames: string[];
  private timer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly dataDir: string,
    private readonly now: () => string,
    entries: ContextEntry[],
    open: string[],
  ) {
    this.file = join(dataDir, "contexts.json");
    this.entries = entries;
    this.openNames = open;
  }

  /**
   * Reads the registry, or makes it. A device that never had one gets the local context, whose
   * files are the ones already in the data directory; nothing of them is touched. A registry
   * that can't be read is moved aside and rebuilt from the directories under `contexts/`.
   */
  static load(
    dataDir: string,
    now: () => string = () => new Date().toISOString(),
  ): ContextRegistry {
    const file = join(dataDir, "contexts.json");
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(file)) {
      try {
        const parsed = FileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
        const names = new Set<string>();
        for (const e of parsed.contexts) {
          if (names.has(e.name)) throw new Error(`two contexts are named ${e.name}`);
          names.add(e.name);
        }
        return new ContextRegistry(dataDir, now, parsed.contexts, parsed.open);
      } catch {
        const stamp = now().replace(/[-:.]/g, "");
        renameSync(file, `${file}.broken-${stamp}`);
      }
    }
    const entries = [ContextRegistry.localEntry(dataDir, now)];
    const root = join(dataDir, "contexts");
    if (existsSync(root)) {
      for (const name of readdirSync(root).sort()) {
        if (!isSegment(name) || name === LOCAL_CONTEXT) continue;
        const log = join(root, name, "log.jsonl");
        if (!existsSync(log)) continue;
        entries.push({
          name,
          title: name,
          logContext: ContextRegistry.logContextOf(log) ?? name,
          dir: join("contexts", name),
          folder: null,
          candidate: null,
          importedFrom: null,
          createdAt: now(),
          lastActivity: statSync(log).mtime.toISOString(),
        });
      }
    }
    const registry = new ContextRegistry(dataDir, now, entries, []);
    registry.flush();
    return registry;
  }

  private static localEntry(dataDir: string, now: () => string): ContextEntry {
    const log = join(dataDir, "log.jsonl");
    const at = existsSync(log) ? statSync(log).mtime.toISOString() : null;
    return {
      name: LOCAL_CONTEXT,
      title: "Local",
      logContext: LOCAL_CONTEXT,
      dir: ".",
      folder: null,
      candidate: null,
      importedFrom: null,
      createdAt: at ?? now(),
      lastActivity: at,
    };
  }

  /** The context a log's first event names, from its address; null when it can't be read. */
  private static logContextOf(log: string): string | null {
    try {
      const first = readFileSync(log, "utf8").split("\n", 1)[0] ?? "";
      const address = (JSON.parse(first) as { address?: unknown }).address;
      const name = typeof address === "string" ? address.split(/[/@]/, 1)[0] : undefined;
      return name !== undefined && isSegment(name) ? name : null;
    } catch {
      return null;
    }
  }

  /** Every context, the one used last first. */
  list(): ContextEntry[] {
    return [...this.entries].sort((a, b) => {
      const x = a.lastActivity ?? a.createdAt;
      const y = b.lastActivity ?? b.createdAt;
      return x < y ? 1 : x > y ? -1 : a.name < b.name ? -1 : 1;
    });
  }

  /** The few used last, for the recent list. */
  recent(limit = 8): ContextEntry[] {
    return this.list().slice(0, limit);
  }

  get(name: string): ContextEntry | null {
    return this.entries.find((e) => e.name === name) ?? null;
  }

  has(name: string): boolean {
    return this.get(name) !== null;
  }

  names(): string[] {
    return this.entries.map((e) => e.name);
  }

  /** The context a folder (by real path) is trusted for, or was last asked about. */
  byFolder(path: string): ContextEntry | null {
    return (
      this.entries.find((e) => e.folder === path) ??
      this.entries.find((e) => e.candidate === path) ??
      null
    );
  }

  byImport(dir: string): ContextEntry | null {
    return this.entries.find((e) => e.importedFrom === dir) ?? null;
  }

  /** A name nobody on this device has: `base`, else `base-2`, `base-3` and so on. */
  uniqueName(base: string): string {
    const root = slugify(base);
    const free = (n: string) => !this.has(n) && n !== LOCAL_CONTEXT;
    if (free(root)) return root;
    for (let i = 2; ; i++) {
      const suffix = `-${i}`;
      const candidate = `${root.slice(0, 63 - suffix.length)}${suffix}`;
      if (free(candidate)) return candidate;
    }
  }

  /**
   * Makes a context. The name is permanent: it is the first part of every address the context
   * writes. A name that is taken, or isn't an address segment, is refused.
   */
  create(o: {
    name: string;
    title?: string;
    logContext?: string;
    candidate?: string | null;
    importedFrom?: string | null;
  }): ContextEntry {
    if (!isSegment(o.name)) throw new RegistryError(`${o.name} can't be a context name`);
    if (this.has(o.name)) throw new RegistryError(`a context named ${o.name} exists already`);
    const entry: ContextEntry = {
      name: o.name,
      title: o.title ?? o.name,
      logContext: o.logContext ?? o.name,
      dir: join("contexts", o.name),
      folder: null,
      candidate: o.candidate ?? null,
      importedFrom: o.importedFrom ?? null,
      createdAt: this.now(),
      lastActivity: null,
    };
    this.entries.push(entry);
    mkdirSync(pathsOf(this.dataDir, entry).dir, { recursive: true });
    this.flush();
    return entry;
  }

  paths(name: string): ContextPaths {
    const e = this.get(name);
    if (e === null) throw new RegistryError(`no context named ${name}`);
    return pathsOf(this.dataDir, e);
  }

  /** Binds a context to a folder a person trusted, or records one that wasn't. */
  setFolder(name: string, answer: { folder: string } | { candidate: string | null }): void {
    const e = this.require(name);
    if ("folder" in answer) {
      e.folder = answer.folder;
      e.candidate = null;
    } else {
      e.candidate = answer.candidate;
    }
    this.flush();
  }

  /** Notes that something happened in a context. Saved soon, and at the latest on `flush`. */
  touch(name: string, at: string = this.now()): void {
    const e = this.get(name);
    if (e === null) return;
    if (e.lastActivity === null || e.lastActivity < at) e.lastActivity = at;
    this.schedule();
  }

  /** Which contexts are open now; they open again at the next start. */
  setOpen(names: readonly string[]): void {
    this.openNames = names.filter((n) => this.has(n));
    this.flush();
  }

  openAtLastExit(): string[] {
    return this.openNames.filter((n) => this.has(n));
  }

  private require(name: string): ContextEntry {
    const e = this.get(name);
    if (e === null) throw new RegistryError(`no context named ${name}`);
    return e;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
    this.timer.unref();
  }

  /** Writes the registry now: to a temporary file, then over the real one. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const json = `${JSON.stringify({ version: 1, contexts: this.entries, open: this.openNames }, null, 2)}\n`;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, json, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
