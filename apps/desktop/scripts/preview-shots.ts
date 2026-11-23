/**
 * Renders the design system's preview of each named state to a PNG, at the state's width, next to
 * the end-to-end screenshots (e2e/artifacts/previews). The previews read the design tokens as CSS
 * custom properties and get them from the page that shows them, so the same `:root` block the
 * app's styles use is put on the page here.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { rootBlock } from "../src/shared/palette.ts";
import { loadStates, previewFile } from "./screenshot-states.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = fileURLToPath(new URL("../e2e/artifacts/previews/", import.meta.url));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
try {
  for (const state of loadStates()) {
    if (state.preview === null) continue;
    const page = await browser.newPage({ viewport: { width: state.width, height: 400 } });
    await page.goto(`file://${join(root, state.preview)}`);
    await page.addStyleTag({ content: `:root {\n${rootBlock()}\n}` });
    await page.screenshot({ path: join(out, previewFile(state)), fullPage: true });
    await page.close();
    console.log(`${state.state}: ${previewFile(state)}`);
  }
} finally {
  await browser.close();
}
