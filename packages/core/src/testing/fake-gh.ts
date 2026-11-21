/**
 * A stand-in for the `gh` program, for tests: it understands `gh api [-X METHOD] <path> [-f k=v]…`
 * and forwards it to a fake GitHub at GH_FAKE_URL, as the signed-in user GH_FAKE_USER. Like gh it
 * prints the response body to stdout, and on an HTTP error it prints `gh: <message> (HTTP n)` to
 * stderr and exits 1. Run it with `node fake-gh.ts api …`. It has no imports and no syntax that
 * Node's type stripping cannot erase, so a test can start it as a command.
 */
const args = process.argv.slice(2);
if (args[0] !== "api") {
  process.stderr.write(`fake gh: only "gh api" is supported, got ${args.join(" ")}\n`);
  process.exit(2);
}
let method = "GET";
let path = "";
const fields: Record<string, string> = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i] as string;
  if (a === "-X" || a === "--method") method = args[++i] as string;
  else if (a === "-f" || a === "--raw-field" || a === "-F" || a === "--field") {
    const kv = args[++i] as string;
    const at = kv.indexOf("=");
    fields[kv.slice(0, at)] = kv.slice(at + 1);
  } else path = a;
}
const base = process.env.GH_FAKE_URL;
if (base === undefined) {
  process.stderr.write("fake gh: GH_FAKE_URL is not set\n");
  process.exit(2);
}
const hasBody = Object.keys(fields).length > 0;
const res = await fetch(`${base}/${path.replace(/^\/+/, "")}`, {
  method: hasBody && method === "GET" ? "POST" : method,
  headers: {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    authorization: "Bearer fake-gh-token",
    "x-fake-gh-user": process.env.GH_FAKE_USER ?? "unknown",
  },
  ...(hasBody ? { body: JSON.stringify(fields) } : {}),
});
const text = await res.text();
process.stdout.write(text);
if (!res.ok) {
  let message = res.statusText;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? message;
  } catch {
    // Not JSON.
  }
  process.stderr.write(`gh: ${message} (HTTP ${res.status})\n`);
  process.exit(1);
}
