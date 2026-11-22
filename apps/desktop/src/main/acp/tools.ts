import {
  bareDraftToolName,
  bareToolName,
  DRAFT_SERVER,
  draftToolName,
  KIRO_READ_ONLY_TOOLS,
  KIRO_SERVER,
  sdkToolName,
} from "@nikovirtala/draft-core";

/**
 * What a tool call is, as far as draft can tell. The identity comes from structured fields the
 * agent sends, never from the human-readable title: titles are for display, and nothing is
 * authorized by one.
 */

export interface CallFields {
  name?: string | null;
  title?: string | null;
  kind?: string | null;
  _meta?: { [key: string]: unknown } | null;
}

export type ToolIdentity =
  | { source: "kiro-remote"; bare: string; name: string }
  /** One of draft's own file and shell tools, which draft's MCP server serves and gates itself. */
  | { source: "draft"; bare: string; name: string }
  | { source: "other"; name: string | null };

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Reads the identity from, in this order: Kiro's `_meta.kiro.mcpTool.identity` (the host-resolved
 * server and tool), the Claude adapter's `_meta.claudeCode.toolName`, and ACP's `name`.
 */
export function toolIdentity(...sources: (CallFields | null | undefined)[]): ToolIdentity {
  for (const s of sources) {
    if (s == null) continue;
    const kiro = obj(obj(obj(s._meta)?.kiro)?.mcpTool);
    const identity = obj(kiro?.identity);
    if (typeof identity?.serverName === "string" && typeof identity.toolName === "string") {
      if (identity.serverName === KIRO_SERVER) {
        const bare = bareToolName(identity.toolName);
        if (bare !== null) return { source: "kiro-remote", bare, name: sdkToolName(bare) };
      }
      if (identity.serverName === DRAFT_SERVER) {
        const bare = bareDraftToolName(identity.toolName);
        if (bare !== null) return { source: "draft", bare, name: draftToolName(bare) };
      }
      return { source: "other", name: `mcp__${identity.serverName}__${identity.toolName}` };
    }
  }
  for (const s of sources) {
    if (s == null) continue;
    const claude = obj(obj(s._meta)?.claudeCode)?.toolName;
    for (const candidate of [claude, s.name]) {
      if (typeof candidate !== "string" || candidate === "") continue;
      // Only the Kiro Remote server's tools, by their full name, are Kiro Remote's.
      if (candidate.startsWith(`mcp__${KIRO_SERVER}__`)) {
        const bare = bareToolName(candidate);
        if (bare !== null) return { source: "kiro-remote", bare, name: sdkToolName(bare) };
      }
      if (candidate.startsWith(`mcp__${DRAFT_SERVER}__`)) {
        const bare = bareDraftToolName(candidate);
        if (bare !== null) return { source: "draft", bare, name: draftToolName(bare) };
      }
      return { source: "other", name: candidate };
    }
  }
  return { source: "other", name: null };
}

/** The ACP tool kinds that only look at things. */
const READ_KINDS: ReadonlySet<string> = new Set([
  "read",
  "search",
  "think",
  "fetch",
  "switch_mode",
]);

/**
 * Whether a call that ran without a permission request is known to change nothing. Kiro Remote's
 * read-only tools are. Anything else is read-only only if the agent says its kind is one that
 * only looks, and MCP hints ("readOnlyHint") are never trusted for this. When in doubt, the call
 * counts as one that may change something.
 */
export function isKnownReadOnly(identity: ToolIdentity, kind: string | null | undefined): boolean {
  if (identity.source === "kiro-remote")
    return (KIRO_READ_ONLY_TOOLS as readonly string[]).includes(identity.bare);
  // A tool of an MCP server draft didn't configure could do anything, whatever its kind says.
  if (identity.name?.startsWith("mcp__")) return false;
  return kind != null && READ_KINDS.has(kind);
}

/**
 * Kiro CLI 3.5 loads an MCP tool's schema with its own "Tool Load" call before it first uses the
 * tool, and runs it without asking: it only reads a tool definition. The call carries no tool
 * identity, so it is recognized by its structured shape, never by its title alone: no server,
 * kind "other", and an input that is exactly `{ id: "tool::<server>::<tool>" }`. Only for an agent
 * draft runs as Kiro. Returns the name draft logs it under, or null.
 */
export function kiroUtilityCall(
  agentKind: string,
  call: {
    kind: string | null;
    title: string | null;
    input: Record<string, unknown>;
    meta: unknown;
  },
): string | null {
  if (agentKind !== "kiro") return null;
  const keys = Object.keys(call.input);
  const kiro = (call.meta as { kiro?: Record<string, unknown> } | null | undefined)?.kiro;
  if (
    call.title === "Tool Load" &&
    call.kind === "other" &&
    keys.length === 1 &&
    typeof call.input.id === "string" &&
    /^tool::[^:]+::[^:]+$/.test(call.input.id) &&
    kiro?.serverName === undefined &&
    kiro?.mcpTool === undefined
  )
    return "kiro:tool_load";
  return null;
}
