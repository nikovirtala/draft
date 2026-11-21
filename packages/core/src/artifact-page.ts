import type { Resolver } from "./resolver.ts";

/**
 * Artifact pages as live stubs: pages the local artifact server hosts (nikovirtala/artifact), with
 * the current version, so a republish shows on the stub. A reference is a link to the page, in
 * path mode (`http://localhost:4400/a/<id>/`) or subdomain mode (`http://<id>.localhost:4400/`),
 * on the server draft is configured for. The id is the artifact's 26-character ULID, in lowercase.
 */

const ID = "[0-9a-z]{26}";

export interface ArtifactPageOptions {
  /** The artifact server, such as `http://localhost:4400`. */
  baseUrl: string;
  /** `ARTIFACT_TOKEN`, when the server asks for one. */
  token?: string | null;
  fetch?: typeof fetch;
}

export interface ArtifactPageState {
  title: string | null;
  currentVersion: number;
  versions: number;
  updatedAt: string | null;
  project: string | null;
  url: string;
  [key: string]: unknown;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class ArtifactPageResolver implements Resolver {
  readonly type = "artifact";
  readonly version = "1";
  private readonly base: URL;
  private readonly fetchFn: typeof fetch;
  private readonly patterns: RegExp[];

  constructor(private readonly o: ArtifactPageOptions) {
    this.base = new URL(o.baseUrl);
    this.fetchFn = o.fetch ?? fetch;
    const host = escapeRe(this.base.host);
    this.patterns = [
      new RegExp(`${escapeRe(this.base.protocol)}//${host}/a/(${ID})(?![0-9a-z])`, "g"),
      new RegExp(`${escapeRe(this.base.protocol)}//(${ID})\\.${host}(?![0-9a-z])`, "g"),
    ];
  }

  detect(text: string): string[] {
    const seen = new Set<string>();
    for (const re of this.patterns) for (const m of text.matchAll(re)) seen.add(m[1] as string);
    return [...seen];
  }

  async fetch(id: string): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
    const res = await this.fetchFn(new URL(`/api/artifacts/${id}`, this.base), { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the artifact server answered ${res.status}`);
    const a = (await res.json()) as Record<string, unknown>;
    const versions = Array.isArray(a.versions) ? (a.versions as Record<string, unknown>[]) : [];
    const current = Number(a.currentVersion ?? versions.length);
    const last = versions.find((v) => Number(v.version) === current) ?? versions.at(-1);
    const state: ArtifactPageState = {
      title: typeof a.title === "string" ? a.title : null,
      currentVersion: current,
      versions: versions.length > 0 ? versions.length : current,
      updatedAt:
        typeof a.updatedAt === "string"
          ? a.updatedAt
          : typeof last?.createdAt === "string"
            ? last.createdAt
            : null,
      project: typeof a.project === "string" ? a.project : null,
      url: typeof a.url === "string" ? a.url : `${this.base.origin}/a/${id}/`,
    };
    return state;
  }
}
