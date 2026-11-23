// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { StatusStub } from "../../src/renderer/src/components/StatusStub.tsx";
import {
  bridge,
  inWorkspace,
  type Mounted,
  mount,
  pullRequestStub,
  workspace,
} from "./harness.tsx";

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

async function showing(state: string, draft = false): Promise<HTMLElement> {
  bridge({});
  const stub = pullRequestStub(state);
  stub.state.draft = draft;
  mounted = await mount(
    inWorkspace(
      workspace(),
      <StatusStub
        from="local@4"
        conversation="local/main"
        target={{ type: stub.type, id: stub.id }}
        stub={stub}
        snapshot={undefined}
      />,
    ),
  );
  return mounted.host.querySelector('[data-testid="stub-status"]') as HTMLElement;
}

describe("a pull request's state in its status stub", () => {
  it("says open, merged and closed in words, and each is a pill of its own look", async () => {
    const seen: Record<string, { words: string; classes: string }> = {};
    for (const state of ["open", "merged", "closed"]) {
      const status = await showing(state);
      seen[state] = { words: status.textContent ?? "", classes: status.className };
      await mounted?.unmount();
      mounted = null;
    }
    expect(seen.open).toEqual({ words: "Open", classes: "stub-status pr-state pr-open" });
    expect(seen.merged).toEqual({ words: "Merged", classes: "stub-status pr-state pr-merged" });
    expect(seen.closed).toEqual({ words: "Closed", classes: "stub-status pr-state pr-closed" });
  });

  it("keeps a draft's words with its state", async () => {
    const status = await showing("open", true);
    expect(status.textContent).toBe("Draft · Open");
    expect(status.classList.contains("pr-open")).toBe(true);
  });
});
