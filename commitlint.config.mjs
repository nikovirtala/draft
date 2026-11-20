// draft's commit rules: Conventional Commits with config-conventional's type list, mirroring ark.
// One change from config-conventional: a description may start with a proper noun or an acronym
// ("Electron shell", "OAuth flow", "MCP tools"), so subject-case is replaced by a rule that only
// rejects sentence case and title case of ordinary words. A first word passes when it is all
// uppercase (an acronym: MCP, OAuth's "OA" prefix counts), has an uppercase letter after its first
// character (OAuth, SQLite, TypeScript), or is in PROPER_NOUNS.
const MAX_DESCRIPTION = 72;

const PROPER_NOUNS = new Set([
  "Biome",
  "Claude",
  "Electron",
  "GitHub",
  "Inter",
  "Kiro",
  "Node",
  "OpenTelemetry",
  "Playwright",
  "React",
  "Source",
  "Vite",
  "Vitest",
  "Wisteria",
  "Zod",
]);

const outcome = (when, ok, message) => [when === "never" ? !ok : ok, message];

/** True when `word` may start a description although it starts with an uppercase letter. */
export function allowedCapitalizedWord(word) {
  const letters = word.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters === "") return true;
  if (PROPER_NOUNS.has(letters)) return true;
  if (letters.length > 1 && letters === letters.toUpperCase()) return true;
  return /\p{Lu}/u.test(letters.slice(1));
}

export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "description-max-length": ({ subject }, when = "always", max = MAX_DESCRIPTION) => {
          if (subject == null) return [true];
          const message = `description must be at most ${max} characters, found ${subject.length}`;
          return outcome(when, subject.length <= max, message);
        },
        "description-start-case": ({ subject }, when = "always") => {
          if (subject == null || subject === "") return [true];
          const first = subject.split(/\s+/)[0] ?? "";
          const head = Array.from(first)[0] ?? "";
          const ok = !/^[\p{Lu}\p{Lt}]$/u.test(head) || allowedCapitalizedWord(first);
          const message = `description must start with a lowercase letter, a proper noun or an acronym, found "${first}"`;
          return outcome(when, ok, message);
        },
      },
    },
  ],
  rules: {
    "subject-case": [0],
    "description-max-length": [2, "always", MAX_DESCRIPTION],
    "description-start-case": [2, "always"],
  },
};
