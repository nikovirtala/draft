// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiSessionFeed } from "@nikovirtala/draft-core/kiro-feed-types";
import { afterEach, describe, expect, it } from "vitest";
import { StatusStub } from "../../src/renderer/src/components/StatusStub.tsx";
import type { Stub } from "../../src/shared/ipc.ts";
import type { Entry } from "../../src/shared/placement.ts";
import { bridge, inWorkspace, type Mounted, mount, workspace } from "./harness.tsx";

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

const SESSION = "01KAHX7Z1M2N3P4Q5R6S7T8V9W";

const feed = (over: Partial<UiSessionFeed> = {}): UiSessionFeed => ({
  feed: "kiro-remote",
  cursor: 12,
  stale: null,
  baseline: 3,
  waits: [],
  links: [],
  lastWake: null,
  ended: [],
  ...over,
});

const sessionStub = (f: UiSessionFeed | undefined): Stub => ({
  target: `kiro-session:${SESSION}`,
  type: "kiro-session",
  id: SESSION,
  observedAt: "2026-11-24T08:00:00.000Z",
  state: { title: "Build the feed view", status: "running", pendingPermissions: 0, repos: [] },
  ...(f === undefined ? {} : { feed: f }),
});

/** The stub on screen: minimized (one line), or inline with its details open. */
async function showing(stub: Stub, inline = false): Promise<HTMLElement> {
  bridge({});
  const entry = (address: string) =>
    ({
      placement: inline ? "inline" : "minimized",
      returnTo: "minimized",
      info: { address, kind: "status", home: "local/main", depth: 0, opens: null, title: "x" },
    }) as unknown as Entry;
  mounted = await mount(
    inWorkspace(
      workspace({ entry }),
      <StatusStub
        from="local@4"
        conversation="local/main"
        target={{ type: stub.type, id: stub.id }}
        stub={stub}
        snapshot={undefined}
      />,
    ),
  );
  return mounted.host;
}

const text = (host: HTMLElement, testid: string) =>
  [...host.querySelectorAll(`[data-testid="${testid}"]`)].map((e) => e.textContent);

describe("a Kiro session's stub, from the change feed", () => {
  it("says nothing of the feed when it has said nothing of the session", async () => {
    const host = await showing(sessionStub(undefined));
    expect(text(host, "stub-waits")).toEqual([]);
    expect(text(host, "stub-last-wake")).toEqual([]);
  });

  it("names each pull request the session waits for, in the waiting chip", async () => {
    const host = await showing(
      sessionStub(
        feed({
          waits: [
            { pr: "octo/repo#7", since: "2026-11-24T08:00:00.000Z" },
            { pr: "octo/repo#8", since: "2026-11-24T08:00:00.000Z" },
          ],
        }),
      ),
    );
    expect(text(host, "stub-waits")).toEqual([
      "Waiting for octo/repo#7",
      "Waiting for octo/repo#8",
    ]);
    // The waiting chip is amber, as what waits is.
    expect(host.querySelector('[data-testid="stub-waits"]')?.className).toBe("pending wait");
  });

  it("says why it last woke, with the pull request, in the moved chip", async () => {
    const host = await showing(
      sessionStub(
        feed({
          lastWake: {
            itemId: "w1",
            kind: "pr_wait_merged",
            cause: "wait",
            pr: "octo/repo#7",
            at: "2026-11-24T08:01:00.000Z",
            text: "a pull request it waited for octo/repo#7 merged",
          },
        }),
      ),
    );
    expect(text(host, "stub-last-wake")).toEqual([
      "Woke: a pull request it waited for octo/repo#7 merged",
    ]);
    expect(host.querySelector('[data-testid="stub-last-wake"]')?.className).toBe("pending moved");
  });

  it("says which feed and cursor it was built from, and what ended without a merge", async () => {
    const host = await showing(
      sessionStub(
        feed({
          ended: [{ pr: "octo/repo#9", reason: "unreadable", at: "2026-11-24T08:02:00.000Z" }],
          links: [{ pr: "octo/repo#2", prState: "open" }],
        }),
      ),
      true,
    );
    const details = host.querySelector('[data-testid="stub-details"]')?.textContent ?? "";
    expect(details).toContain("the kiro-remote feed, cursor 12, from the session as it was at 3");
    expect(details).toContain("octo/repo#9: couldn't be read");
    expect(details).toContain("octo/repo#2 (open)");
  });

  it("marks the waits out of date when the feed stopped, in words", async () => {
    const stale = "the Kiro Remote feed stopped at event 3: draft can't read wait.paused";
    const host = await showing(sessionStub(feed({ stale })), true);
    expect(text(host, "stub-feed-stale")).toEqual(["Waits may be out of date"]);
    expect(host.querySelector('[data-testid="stub-details"]')?.textContent).toContain(stale);
  });
});

describe("the waiting edge's colours", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/renderer/src/styles.css"),
    "utf8",
  );
  const rule = (selector: string) =>
    css.match(new RegExp(`${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

  it("draws a wait in the waiting mark, and its arrow too", () => {
    expect(rule(".graph-edge.waits")).toContain("stroke: var(--waiting-mark)");
    expect(rule(".graph-arrowhead.waits")).toContain("fill: var(--waiting-mark)");
  });
});
