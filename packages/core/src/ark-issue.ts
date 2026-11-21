import type { GithubClient } from "./github.ts";
import type { Resolver } from "./resolver.ts";

/**
 * ark issues as live stubs. An issue's state is never stored; it is folded from the event files
 * in the repository, so the resolver reads the event files on GitHub and folds them the way issues
 * does: `opened` and `stopped` mean open, `started` means in progress, `closed` means closed with
 * a resolution, `reopened` means open again.
 *
 * A reference names the repository by its source name, as ark's qualified ids do
 * (`draft:15cxvdep`, the `[[sources]]` name in the tool's config), or by a link to one of the
 * issue's files. The target's id is `owner/repo:issue-id`.
 */

/** Canonical issue ids: 8 lowercase Crockford base32 characters. */
export const ARK_ID = "[0-9a-hjkmnp-tv-z]{8}";
const ID = ARK_ID;
export type ArkIssueStatus = "open" | "in-progress" | "closed";

export interface ArkIssueEvent {
  type: string;
  at: string;
  file: string;
}

export interface ArkIssueState {
  repo: string;
  id: string;
  title: string | null;
  status: ArkIssueStatus;
  /** How it was closed: done, wontfix, duplicate or obsolete. */
  resolution: string | null;
  /** Every event, oldest first, with the time its file name carries. */
  events: ArkIssueEvent[];
  eventCount: number;
  url: string;
  [key: string]: unknown;
}

export interface ArkIssueOptions {
  /** Source name to `owner/repo`, as in the tool's `[[sources]]`. */
  sources: Readonly<Record<string, string>>;
  /** Where the issue log is in each repository. */
  root?: string;
}

export function arkIssueId(repo: string, id: string): string {
  return `${repo}:${id}`;
}

export function parseArkIssueId(id: string): { repo: string; issue: string } | null {
  const m = new RegExp(`^([^/:]+/[^/:]+):(${ID})$`).exec(id);
  return m === null ? null : { repo: m[1] as string, issue: m[2] as string };
}

/** An event file's name: `20261121T155120Z-tk1h-proposed.yaml`. */
export const EVENT_FILE = /^(\d{8}T\d{6}Z)-([0-9a-z]{4})-([a-z][a-z-]*)\.ya?ml$/;

/** The events a directory listing names, oldest first, with the time each file name carries. */
export function parseEventFiles(
  listing: readonly { name: string; type: string }[],
): ArkIssueEvent[] {
  return listing
    .filter((f) => f.type === "file" && EVENT_FILE.test(f.name))
    .map((f) => {
      const m = EVENT_FILE.exec(f.name) as RegExpExecArray;
      return { type: m[3] as string, at: isoOf(m[1] as string), file: f.name };
    })
    .sort((a, b) => (a.file < b.file ? -1 : 1));
}

function isoOf(stamp: string): string {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
}

/** The value of a top-level `key:` under `data:` in an event file, unquoted. */
export function dataField(yaml: string, key: string): string | null {
  const m = new RegExp(`^ {2}${key}:[ \\t]*(.*)$`, "m").exec(yaml);
  if (m === null) return null;
  let v = (m[1] as string).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    v = v.slice(1, -1);
  return v === "" || v === "null" ? null : v;
}

export class ArkIssueResolver implements Resolver {
  readonly type = "ark-issue";
  readonly version = "1";
  private readonly root: string;
  /** Event files never change, so what was read from one is kept. */
  private readonly texts = new Map<string, string | null>();

  constructor(
    private readonly github: GithubClient,
    private readonly o: ArkIssueOptions,
  ) {
    this.root = (o.root ?? "docs/issues").replace(/^\/+|\/+$/g, "");
  }

  detect(text: string): string[] {
    const seen = new Set<string>();
    const names = Object.keys(this.o.sources);
    if (names.length > 0) {
      const re = new RegExp(
        `(?<![A-Za-z0-9._:/-])(${names.map(escapeRe).join("|")}):(${ID})(?![0-9A-Za-z])`,
        "g",
      );
      for (const m of text.matchAll(re)) {
        const repo = this.o.sources[m[1] as string];
        if (repo !== undefined) seen.add(arkIssueId(repo, m[2] as string));
      }
    }
    const link = new RegExp(
      `github\\.com/([A-Za-z0-9-]+/[A-Za-z0-9._-]+)/(?:blob|tree)/[^\\s/]+/${escapeRe(this.root)}/(?:items|events)/(${ID})(?![0-9A-Za-z])`,
      "g",
    );
    for (const m of text.matchAll(link)) seen.add(arkIssueId(m[1] as string, m[2] as string));
    return [...seen];
  }

  private async text(repo: string, path: string): Promise<string | null> {
    const key = `${repo}/${path}`;
    if (this.texts.has(key)) return this.texts.get(key) ?? null;
    const t = await this.github.getText(`/repos/${repo}/contents/${path}`);
    this.texts.set(key, t);
    return t;
  }

  async fetch(id: string): Promise<Record<string, unknown> | null> {
    const p = parseArkIssueId(id);
    if (p === null) return null;
    const dir = `${this.root}/events/${p.issue}`;
    const listing = await this.github.getJson<{ name: string; type: string }[]>(
      `/repos/${p.repo}/contents/${dir}`,
    );
    if (listing === null || !Array.isArray(listing)) return null;
    const events = parseEventFiles(listing);
    if (events.length === 0) return null;
    let status: ArkIssueStatus = "open";
    for (const e of events) {
      if (e.type === "started") status = "in-progress";
      else if (e.type === "opened" || e.type === "stopped" || e.type === "reopened")
        status = "open";
      else if (e.type === "closed") status = "closed";
    }
    const opened = events.find((e) => e.type === "opened");
    const closed = [...events].reverse().find((e) => e.type === "closed");
    const title =
      opened === undefined
        ? null
        : dataField((await this.text(p.repo, `${dir}/${opened.file}`)) ?? "", "title");
    const resolution =
      status === "closed" && closed !== undefined
        ? dataField((await this.text(p.repo, `${dir}/${closed.file}`)) ?? "", "resolution")
        : null;
    const state: ArkIssueState = {
      repo: p.repo,
      id: p.issue,
      title,
      status,
      resolution,
      events,
      eventCount: events.length,
      url: `https://github.com/${p.repo}/tree/HEAD/${dir}`,
    };
    return state;
  }
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
