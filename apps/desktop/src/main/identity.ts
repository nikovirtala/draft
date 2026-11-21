import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { newItemId, type UserActor } from "@nikovirtala/draft-core";

/**
 * The person at this device, as the log knows them: a ULID created on the first run and kept in
 * `config.json`, with a display name. Never an assumed "me": every event a person writes carries
 * this id, so adding people later needs no log migration. The agent never acts under it.
 */
export interface LocalIdentity {
  id: string;
  name: string;
}

export interface IdentitySources {
  /** `git config user.name`, or null when git or the setting is missing. */
  gitName?: () => string | null;
  /** The OS account name. */
  osName?: () => string | null;
  newId?: () => string;
}

export function gitUserName(): string | null {
  try {
    const name = execFileSync("git", ["config", "--get", "user.name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return name === "" ? null : name;
  } catch {
    return null;
  }
}

function osUserName(): string | null {
  try {
    const name = userInfo().username.trim();
    return name === "" ? null : name;
  } catch {
    return null;
  }
}

/** The display name for a new identity: git's user.name, else the OS user, else a plain label. */
export function displayName(s: IdentitySources = {}): string {
  return (s.gitName ?? gitUserName)() ?? (s.osName ?? osUserName)() ?? "Local user";
}

/**
 * Reads the identity from `config.json` in the data directory, creating it on the first run. Other
 * settings in the file are kept as they are.
 */
export function ensureIdentity(dataDir: string, s: IdentitySources = {}): LocalIdentity {
  const file = join(dataDir, "config.json");
  const config = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
    : {};
  const user = config.user as Partial<LocalIdentity> | undefined;
  if (
    typeof user?.id === "string" &&
    user.id !== "" &&
    typeof user.name === "string" &&
    user.name !== ""
  ) {
    return { id: user.id, name: user.name };
  }
  const identity: LocalIdentity = {
    id: typeof user?.id === "string" && user.id !== "" ? user.id : newItemId(s.newId),
    name: displayName(s),
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...config, user: identity }, null, 2)}\n`);
  renameSync(tmp, file);
  return identity;
}

export function userActor(identity: LocalIdentity): UserActor {
  return { kind: "user", id: identity.id, name: identity.name };
}
