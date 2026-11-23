import { FeedPageSchema, PR_REF, type RawFeedPage } from "./feed.ts";
import type { FeedSource } from "./feed-follow.ts";

/**
 * The part of Kiro Remote's REST API (`/v1`, docs/rest-api.md) the change feed's reader needs:
 * the feed itself and a session's links and waits, which are its starting state because nothing
 * before the feed has an event. Reads only.
 */

export interface SessionSnapshot {
  links: { pr: string; method: string; prState: string }[];
  waits: { pr: string; source: string; since: string }[];
}

export interface KiroFeedApi extends FeedSource {
  /** A session's links and waits now; null when the service has no such session for this person. */
  session(id: string): Promise<SessionSnapshot | null>;
}

export class KiroRemoteHttpError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`Kiro Remote answered ${status} to ${what}`);
    this.name = "KiroRemoteHttpError";
  }
}

export interface KiroRemoteRestOptions {
  /** The service's base URL, without `/v1`. */
  baseUrl: string;
  /**
   * A bearer token, or null for a Kiro Remote that runs without sign-in. Throws when there is none
   * to be had, such as before the person has signed in: the feed is read quietly, never by opening
   * a browser from the background.
   */
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
}

export class KiroRemoteRest implements KiroFeedApi {
  readonly id = "kiro-remote";
  private readonly doFetch: typeof fetch;

  constructor(private readonly o: KiroRemoteRestOptions) {
    this.doFetch = o.fetch ?? fetch;
  }

  private async get(path: string): Promise<Response> {
    const token = await this.o.token();
    return this.doFetch(`${this.o.baseUrl.replace(/\/+$/, "")}/v1${path}`, {
      headers: {
        accept: "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
    });
  }

  async page(after: number, limit: number): Promise<RawFeedPage> {
    const res = await this.get(`/events?after=${after}&limit=${limit}`);
    if (!res.ok) throw new KiroRemoteHttpError(res.status, "GET /v1/events");
    const body = FeedPageSchema.safeParse(await res.json());
    if (!body.success) throw new Error("Kiro Remote's /v1/events did not answer with a page");
    return body.data;
  }

  async session(id: string): Promise<SessionSnapshot | null> {
    const res = await this.get(`/sessions/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new KiroRemoteHttpError(res.status, "GET /v1/sessions/{id}");
    return parseSession(await res.json());
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, fallback: string): string =>
  typeof v === "string" && v !== "" ? v : fallback;

/**
 * A session's links and waits from what the service answered: the session itself, or wrapped as
 * `{ session }` as the MCP tool does. Entries without a pull request reference are left out.
 */
export function parseSession(body: unknown): SessionSnapshot | null {
  const s = isRecord(body) && isRecord(body.session) ? body.session : body;
  if (!isRecord(s)) return null;
  const links: SessionSnapshot["links"] = [];
  for (const l of Array.isArray(s.links) ? s.links : []) {
    if (!isRecord(l) || typeof l.pr !== "string" || !PR_REF.test(l.pr)) continue;
    links.push({
      pr: l.pr,
      method: text(l.linkedBy, "unknown"),
      prState: text(l.prState, "unknown"),
    });
  }
  const waits: SessionSnapshot["waits"] = [];
  for (const w of Array.isArray(s.waits) ? s.waits : []) {
    if (!isRecord(w) || typeof w.pr !== "string" || !PR_REF.test(w.pr)) continue;
    waits.push({ pr: w.pr, source: text(w.source, "unknown"), since: text(w.createdAt, "") });
  }
  return { links, waits };
}
