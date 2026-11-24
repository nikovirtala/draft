import type { FakeGithub } from "./fake-github.ts";

/**
 * The ledgers of a real repository, in the size they have, so a test can count what reading them
 * costs. A decision has three event files (proposed, linked, accepted) and an issue four (opened,
 * linked, started, closed); the proposal, the links and the closing are read for a title, the
 * relations and a resolution, so most files cost a request. `DRAFT_LEDGER` and `ARK_LEDGER` have
 * the number of event files that nikovirtala/draft (212) and nikovirtala/ark (269) had when this
 * was measured.
 */

export interface LedgerSize {
  decisions: number;
  issues: number;
}

export const DRAFT_LEDGER: LedgerSize = { decisions: 20, issues: 38 };
export const ARK_LEDGER: LedgerSize = { decisions: 27, issues: 47 };

/** How many event files a ledger of this size has. */
export const ledgerFileCount = (size: LedgerSize): number => size.decisions * 3 + size.issues * 4;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const START = Date.UTC(2026, 9, 1, 8, 0, 0);

/** The id of the nth decision (`d`) or issue (`i`) of a ledger. */
export const ledgerId = (prefix: "d" | "k", n: number): string => id(prefix, n);

const id = (prefix: string, n: number): string =>
  `${prefix}${String(n)
    .padStart(7, "0")
    .split("")
    .map((d) => ALPHABET[Number(d)])
    .join("")}`;

const stamp = (minute: number): string =>
  new Date(START + minute * 60_000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** One event file: its path and text. `n` orders the files of one record. */
export function ledgerEvent(
  root: "docs/adr" | "docs/issues",
  record: string,
  minute: number,
  n: number,
  type: string,
  data: Record<string, string> = {},
): [string, string] {
  const body = Object.entries(data)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  return [
    `${root}/events/${record}/${stamp(minute)}-${String(n).padStart(4, "0")}-${type}.yaml`,
    `envelope: ledger/v1\nsubject: ${record}\ntype: ${type}\ndata:\n${body === "" ? "  {}" : body}\n`,
  ];
}

/** The files of a ledger of this size, by path. Every file's text differs, and so does every blob. */
export function ledgerFiles(size: LedgerSize, salt = ""): Record<string, string> {
  const files: Record<string, string> = {};
  const add = ([path, text]: [string, string]) => {
    // The salt makes a repository's files differ from another's, so no blob is shared by two.
    files[path] = salt === "" ? text : `${text}# ${salt}\n`;
  };
  for (let i = 0; i < size.decisions; i++) {
    const record = id("d", i);
    const next = id("d", (i + 1) % size.decisions);
    add(ledgerEvent("docs/adr", record, i * 4, 1, "proposed", { title: `${salt}Decision ${i}` }));
    add(ledgerEvent("docs/adr", record, i * 4 + 1, 2, "linked", { to: next, rel: "relates-to" }));
    add(ledgerEvent("docs/adr", record, i * 4 + 2, 3, "accepted", { reason: `reason ${i}` }));
  }
  for (let i = 0; i < size.issues; i++) {
    const record = id("k", i);
    const next = id("k", (i + 1) % size.issues);
    add(ledgerEvent("docs/issues", record, i * 5, 1, "opened", { title: `${salt}Issue ${i}` }));
    add(
      ledgerEvent("docs/issues", record, i * 5 + 1, 2, "linked", { to: next, rel: "depends-on" }),
    );
    add(ledgerEvent("docs/issues", record, i * 5 + 2, 3, "started"));
    add(ledgerEvent("docs/issues", record, i * 5 + 3, 4, "closed", { resolution: "done" }));
  }
  return files;
}

/** Puts a ledger of this size on the default branch of a fake repository. */
export function seedLedger(github: FakeGithub, repo: string, size: LedgerSize, salt = ""): number {
  const files = ledgerFiles(size, salt);
  github.addFiles(repo, "main", files);
  return Object.keys(files).length;
}

/** Adds one more event file to the default branch: a record being closed, say. */
export function addLedgerEvent(github: FakeGithub, repo: string, file: [string, string]): void {
  const main = github.files.get(repo)?.get("main");
  if (main === undefined) throw new Error(`no fake ledger in ${repo}`);
  main.set(file[0], file[1]);
}
