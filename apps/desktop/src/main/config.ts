import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * draft's configuration: `config.json` in the data directory, overridden by environment
 * variables. Secrets are never configured here: the Anthropic API key comes from the environment
 * of the main process only, and Kiro Remote tokens from the OAuth sign-in (kept in safeStorage).
 */
const FileConfigSchema = z
  .object({
    kiroRemoteUrl: z.url().optional(),
    model: z.string().min(1).optional(),
    /** The local identity, written on the first run (see identity.ts). */
    user: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional(),
  })
  .strict();

export interface Config {
  dataDir: string;
  /** Kiro Remote's base URL; its MCP endpoint is `<base>/mcp`. Unset: no Kiro tools. */
  kiroRemoteUrl: string | null;
  /** "oauth" for the real service; "none" for a local fake without sign-in. */
  kiroAuth: "oauth" | "none";
  model: string;
  agent: "sdk" | "fake";
  fakeScript: string | null;
  pollBaseMs: number;
  pollMaxMs: number;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

export function loadConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = join(dataDir, "config.json");
  const fromFile = existsSync(file)
    ? FileConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    : {};
  const agent = env.DRAFT_AGENT === "fake" ? "fake" : "sdk";
  return {
    dataDir,
    kiroRemoteUrl: env.DRAFT_KIRO_REMOTE_URL ?? fromFile.kiroRemoteUrl ?? null,
    kiroAuth: env.DRAFT_KIRO_AUTH === "none" ? "none" : "oauth",
    model: env.DRAFT_MODEL ?? fromFile.model ?? DEFAULT_MODEL,
    agent,
    fakeScript: env.DRAFT_FAKE_SCRIPT ?? null,
    pollBaseMs: Number(env.DRAFT_POLL_BASE_MS ?? 2000),
    pollMaxMs: Number(env.DRAFT_POLL_MAX_MS ?? 60_000),
  };
}
