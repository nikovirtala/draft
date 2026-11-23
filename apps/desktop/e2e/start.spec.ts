import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { launchApp, test } from "./harness.ts";

/**
 * The app starts: both processes load what they import and the renderer draws. The `start` job of
 * CI runs only this spec, on a build made with packages/core/dist removed, so a core import the
 * Vite aliases can't resolve fails there as it does for a developer's `pnpm dev`. Any line the app
 * prints that the harness fails on (a deprecation, a console error) fails it too.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");

test("starts from source and loads the renderer", async () => {
  const display = process.env.DISPLAY === undefined ? ["--ozone-platform=headless"] : [];
  const electronApp = await launchApp({
    args: [join(app, "out/main/index.js"), "--no-sandbox", "--disable-gpu", ...display],
    cwd: app,
    env: {
      ...process.env,
      DRAFT_DATA_DIR: mkdtempSync(join(tmpdir(), "draft-e2e-start-")),
      DRAFT_AGENT: "fake",
      DRAFT_AGENT_COMMAND: process.execPath,
      DRAFT_AGENT_ARGS: JSON.stringify([join(app, "test/fake-acp-agent.ts")]),
      FAKE_ACP_SCRIPT: join(here, "fake-acp-script.json"),
      DRAFT_ENVIRONMENT: "e2e",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    },
  });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByLabel("Message")).toBeVisible();
  // The renderer drew something into its root, and its bundle is the one built from source.
  await expect(page.locator("#root > *").first()).toBeAttached();
  await electronApp.close();
});
