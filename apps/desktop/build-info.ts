import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Build-time provenance for draft's own telemetry, baked into the main process bundle through
 * electron-vite's `define`. Never read from a git remote: remote URLs can carry credentials.
 */

/** The commit being built: DRAFT_BUILD_REVISION (CI sets the PR head), else git, else "unknown". */
export function buildRevision(
  env: NodeJS.ProcessEnv = process.env,
  cwd = import.meta.dirname,
): string {
  const fromEnv = env.DRAFT_BUILD_REVISION?.trim();
  if (fromEnv !== undefined && /^[0-9a-f]{7,64}$/.test(fromEnv)) return fromEnv;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

/** The repository's canonical https URL, from the package.json `repository` field. */
export function repositoryUrl(packageJson: { repository?: string | { url?: string } }): string {
  const raw =
    typeof packageJson.repository === "string"
      ? packageJson.repository
      : packageJson.repository?.url;
  if (raw === undefined) return "unknown";
  const url = raw.replace(/^git\+/, "").replace(/\.git$/, "");
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (
    parsed === null ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return "unknown";
  }
  return `${parsed.origin}${parsed.pathname}`;
}

export function buildInfo(): { revision: string; repository: string } {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  return { revision: buildRevision(), repository: repositoryUrl(pkg) };
}
