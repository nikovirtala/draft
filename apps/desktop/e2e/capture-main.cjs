// The entry the harness starts Electron with, in place of the app's main module (see launchApp in
// harness.ts). It copies every write to the main process's stderr to the file DRAFT_E2E_MAIN_LOG
// names, from the first line: Electron prints its deprecations with console.warn while the app
// gets ready, before Playwright hands the harness the process. Then it loads the app's main module
// (DRAFT_E2E_MAIN) under that module's own path in process.argv, so the app reads the command line
// it would have read.
const { appendFileSync, writeFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");

const file = process.env.DRAFT_E2E_MAIN_LOG;
const main = process.env.DRAFT_E2E_MAIN;
if (!file || !main) throw new Error("capture-main.cjs needs DRAFT_E2E_MAIN_LOG and DRAFT_E2E_MAIN");

writeFileSync(file, "");
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  try {
    appendFileSync(file, typeof chunk === "string" ? chunk : Buffer.from(chunk));
  } catch {}
  return write(chunk, ...rest);
};

const at = process.argv.indexOf(__filename);
if (at >= 0) process.argv[at] = main;
import(pathToFileURL(main).href).catch((error) => {
  console.error(error);
  process.exit(1);
});
