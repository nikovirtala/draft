/**
 * Kiro Remote, as draft sees it: the MCP server's tool names, which of them change things, the
 * session id format, and the state a session stub shows.
 *
 * Source: nikovirtala/kiro-remote packages/mcp/src/tools.ts (the 16 tools and their annotations),
 * packages/api/src/mcp-seam.ts (ClientSession, ClientPermission) and packages/core/src/service
 * (session ids come from `ulid()`: 26 uppercase Crockford base32 characters).
 */

/** The server name draft registers Kiro Remote under; the Agent SDK prefixes tools with it. */
export const KIRO_SERVER = "kiro-remote";

/** The MCP endpoint path below the Kiro Remote base URL (kiro-remote docs/mcp.md). */
export const KIRO_MCP_PATH = "/mcp";

export function kiroMcpUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${KIRO_MCP_PATH}`;
}

/** Tools that only read: they run without asking. */
export const KIRO_READ_ONLY_TOOLS = [
  "kiro_capabilities",
  "kiro_list_models",
  "kiro_list_sessions",
  "kiro_get_session",
  "kiro_wait_for_events",
  "kiro_get_transcript",
  "kiro_list_permissions",
] as const;

/** Tools that change things: each call asks the user first, inside the conversation. */
export const KIRO_MUTATING_TOOLS = [
  "kiro_launch_session",
  "kiro_adopt_session",
  "kiro_send_prompt",
  "kiro_set_config",
  "kiro_link_pull_request",
  "kiro_unlink_pull_request",
  "kiro_cancel_turn",
  "kiro_delete_session",
] as const;

/**
 * Tools only a person may use. Answering a permission request is a human gate, so draft refuses
 * it when the agent asks, and the person's own answer goes through draft's interrupts, as the
 * person, never through the agent (docs/model.md, "Acceptance").
 */
export const KIRO_PERSON_ONLY_TOOLS = ["kiro_answer_permission"] as const;

export type ToolPermission = "allow" | "ask" | "deny";

/** The tool name the Agent SDK uses for a Kiro Remote tool. */
export function sdkToolName(tool: string): string {
  return `mcp__${KIRO_SERVER}__${tool}`;
}

/** The bare Kiro Remote tool name, from either the bare or the SDK-prefixed form. */
export function bareToolName(name: string): string | null {
  const prefix = `mcp__${KIRO_SERVER}__`;
  const bare = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return /^kiro_[a-z_]+$/.test(bare) ? bare : null;
}

/**
 * The permission policy: read-only Kiro tools are allowed, Kiro tools that change things ask, and
 * everything else is denied: built-in Claude Code tools, other servers, unknown Kiro tools, and
 * the tools only a person may use (`kiro_answer_permission`).
 */
export function toolPermission(name: string): ToolPermission {
  const bare = bareToolName(name);
  if (bare === null) return "deny";
  if ((KIRO_READ_ONLY_TOOLS as readonly string[]).includes(bare)) return "allow";
  if ((KIRO_MUTATING_TOOLS as readonly string[]).includes(bare)) return "ask";
  return "deny";
}

/**
 * A Kiro Remote session id: a ULID. Matched case-sensitively (ulid() emits uppercase), as a whole
 * token: not inside a longer run of letters and digits. draft's own item ids are lowercase ULIDs,
 * so they never match. Other ULIDs (turn ids, for example) can match; the resolver confirms each
 * candidate with kiro_get_session before anything is referenced.
 */
const SESSION_ID_RE = /(?<![0-9A-Za-z])[0-7][0-9A-HJKMNP-TV-Z]{25}(?![0-9A-Za-z])/g;

/** Distinct candidate session ids in order of first appearance. */
export function findSessionIds(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(SESSION_ID_RE)) seen.add(m[0]);
  return [...seen];
}

/** One answer a permission request offers, as the agent supplied it (ACP's permission options). */
export interface KiroPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/** A permission request waiting on a person: enough to show it and to answer it. */
export interface KiroPendingPermission {
  requestId: string;
  /** What the session wants to do, as its tool call titles it. */
  title: string;
  /** The tool call's kind (execute, edit, ...), when it names one. */
  kind: string | null;
  options: KiroPermissionOption[];
}

/** What a session stub shows. */
export interface KiroSessionState {
  title: string | null;
  status: string;
  pendingPermissions: number;
  /** The requests behind that count, oldest first. */
  permissions: KiroPendingPermission[];
  repos: string[];
  updatedAt: string | null;
  [key: string]: unknown;
}

/** The parts of a ClientSession draft reads. */
export interface KiroSessionView {
  id: string;
  title: string | null;
  status: string;
  repos?: string[];
  updatedAt?: string;
}

export function sessionState(
  session: KiroSessionView,
  pending: readonly KiroPendingPermission[],
): KiroSessionState {
  return {
    title: session.title ?? null,
    status: session.status,
    pendingPermissions: pending.length,
    permissions: [...pending],
    repos: session.repos ?? [],
    updatedAt: session.updatedAt ?? null,
  };
}

/** The pending requests of a `kiro_list_permissions` result, as the session stub carries them. */
export function pendingPermissions(structured: unknown): KiroPendingPermission[] {
  const list = (structured as { permissions?: unknown } | null)?.permissions;
  if (!Array.isArray(list)) return [];
  const out: KiroPendingPermission[] = [];
  for (const p of list as Record<string, unknown>[]) {
    if (p.status !== undefined && p.status !== "pending") continue;
    if (typeof p.requestId !== "string") continue;
    const call = (p.toolCall ?? {}) as Record<string, unknown>;
    const options = Array.isArray(p.options) ? (p.options as Record<string, unknown>[]) : [];
    out.push({
      requestId: p.requestId,
      title: typeof call.title === "string" ? call.title : "A tool call",
      kind: typeof call.kind === "string" ? call.kind : null,
      options: options
        .filter((o) => typeof o.optionId === "string")
        .map((o) => ({
          optionId: o.optionId as string,
          name: typeof o.name === "string" ? o.name : String(o.optionId),
          kind: typeof o.kind === "string" ? o.kind : "",
        })),
    });
  }
  return out;
}

/**
 * The option that answers a permission request: allow picks "allow_once" (else any allowing
 * option), deny picks "reject_once" (else any rejecting one). Null when the request offers none.
 */
export function chooseOption(p: KiroPendingPermission, allow: boolean): string | null {
  const side = allow ? "allow" : "reject";
  const once = p.options.find((o) => o.kind === `${side}_once`);
  const any = p.options.find((o) => o.kind.startsWith(side));
  return (once ?? any)?.optionId ?? null;
}

/** The structured result of one MCP tool call. */
export interface ToolCallResult {
  isError: boolean;
  /** `structuredContent`, or the text content parsed as JSON when it is JSON. */
  structured: unknown;
  /** The text content, joined. */
  text: string;
}

/** Calls Kiro Remote tools; the real one speaks MCP over HTTP, tests use a fake. */
export interface KiroRemoteTools {
  call(tool: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/** A bounded, single-line summary of a tool result, for the log. */
export function summarizeResult(r: ToolCallResult, max = 2000): string {
  const s = r.text !== "" ? r.text : JSON.stringify(r.structured ?? null);
  return s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s;
}
