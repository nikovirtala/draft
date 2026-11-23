/**
 * Writes the palette's values where they are read: the `:root` of styles.css and the table in
 * docs/implementation.md. Run it after changing a value in src/shared/palette.ts
 * (`pnpm --filter @nikovirtala/draft-desktop palette:sync`); a test fails when they differ.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { between, CSS_MARKS, DOC_MARKS, docTable, rootBlock } from "../src/shared/palette.ts";

const css = fileURLToPath(new URL("../src/renderer/src/styles.css", import.meta.url));
const doc = fileURLToPath(new URL("../../../docs/implementation.md", import.meta.url));

writeFileSync(css, between(readFileSync(css, "utf8"), CSS_MARKS, rootBlock()));
writeFileSync(doc, between(readFileSync(doc, "utf8"), DOC_MARKS, docTable()));
