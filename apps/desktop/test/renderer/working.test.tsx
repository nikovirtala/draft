// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/App.tsx";
import { ConversationView } from "../../src/renderer/src/components/ConversationView.tsx";
import { MapStub } from "../../src/renderer/src/components/MapBlock.tsx";
import { StatusStub } from "../../src/renderer/src/components/StatusStub.tsx";
import {
  GlobalWorking,
  WORKING_DELAY_MS,
  Working,
  workingLabel,
} from "../../src/renderer/src/components/Working.tsx";
import type { Boot } from "../../src/shared/ipc.ts";
import type { Entry } from "../../src/shared/placement.ts";
import {
  advance,
  bridge,
  conversationState,
  emptyMap,
  indicators,
  inWorkspace,
  type Mounted,
  mount,
  pullRequestStub,
  workspace,
} from "./harness.tsx";

let mounted: Mounted | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("the indicator's delay", () => {
  it("shows after the delay and not before", async () => {
    mounted = await mount(<Working active label="Reading" place="stub" />);
    expect(indicators(mounted.host)).toHaveLength(0);
    await advance(WORKING_DELAY_MS - 1);
    expect(indicators(mounted.host)).toHaveLength(0);
    await advance(1);
    expect(indicators(mounted.host)).toHaveLength(1);
  });

  it("never shows for work that ends before the delay", async () => {
    mounted = await mount(<Working active label="Reading" place="stub" />);
    await advance(WORKING_DELAY_MS - 1);
    await mounted.render(<Working active={false} label="Reading" place="stub" />);
    await advance(WORKING_DELAY_MS * 3);
    expect(indicators(mounted.host)).toHaveLength(0);
  });

  it("goes the moment the work does, and waits the delay again for the next", async () => {
    mounted = await mount(<Working active label="Reading" place="stub" />);
    await advance(WORKING_DELAY_MS);
    expect(indicators(mounted.host)).toHaveLength(1);
    await mounted.render(<Working active={false} label="Reading" place="stub" />);
    expect(indicators(mounted.host)).toHaveLength(0);
    await mounted.render(<Working active label="Reading" place="stub" />);
    expect(indicators(mounted.host)).toHaveLength(0);
    await advance(WORKING_DELAY_MS);
    expect(indicators(mounted.host)).toHaveLength(1);
  });

  it("is named in words for a screen reader, and looks the same in every place", async () => {
    mounted = await mount(
      <>
        <Working active label="Kiro is working" place="turn" />
        <Working active label="Reading GitHub" place="map" showLabel />
      </>,
    );
    await advance(WORKING_DELAY_MS);
    const [turn, map] = indicators(mounted.host) as [HTMLElement, HTMLElement];
    expect(turn.getAttribute("role")).toBe("status");
    expect(turn.textContent).toBe("Kiro is working");
    expect(turn.querySelector(".visually-hidden")?.textContent).toBe("Kiro is working");
    expect(map.querySelector(".working-label")?.textContent).toBe("Reading GitHub");
    expect(turn.querySelector(".working-ring")?.getAttribute("aria-hidden")).toBe("true");
    expect(map.querySelector(".working-ring")?.className).toBe(
      turn.querySelector(".working-ring")?.className,
    );
  });
});

describe("the indicator in each place, only while there is work", () => {
  it("an agent turn shows it in its conversation", async () => {
    const view = (busy: boolean) =>
      inWorkspace(
        workspace({ states: { "local/main": conversationState({ busy }) } }),
        <ConversationView conversation="local/main" />,
      );
    bridge({});
    mounted = await mount(view(false));
    await advance(WORKING_DELAY_MS * 2);
    expect(indicators(mounted.host, "turn")).toHaveLength(0);
    await mounted.render(view(true));
    expect(indicators(mounted.host, "turn")).toHaveLength(0);
    await advance(WORKING_DELAY_MS);
    expect(indicators(mounted.host, "turn")).toHaveLength(1);
    expect(indicators(mounted.host, "turn")[0]?.textContent).toBe("Kiro is working");
    await mounted.render(view(false));
    expect(indicators(mounted.host, "turn")).toHaveLength(0);
  });

  it("a stub being resolved shows it on that stub, and not on another", async () => {
    const stub = pullRequestStub("open");
    const view = (resolving: string[]) =>
      inWorkspace(
        workspace({ resolving: new Set(resolving) }),
        <>
          <StatusStub
            from="local@4"
            conversation="local/main"
            target={{ type: stub.type, id: stub.id }}
            stub={stub}
            snapshot={undefined}
          />
          <StatusStub
            from="local@5"
            conversation="local/main"
            target={{ type: "pull-request", id: "nikovirtala/draft#37" }}
            stub={undefined}
            snapshot={undefined}
          />
        </>,
      );
    mounted = await mount(view([]));
    await advance(WORKING_DELAY_MS * 2);
    expect(indicators(mounted.host, "stub")).toHaveLength(0);
    await mounted.render(view([stub.target]));
    await advance(WORKING_DELAY_MS);
    const shown = indicators(mounted.host, "stub");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.closest('[data-testid="stub"]')?.getAttribute("data-stub-target")).toBe(
      stub.target,
    );
    expect(shown[0]?.textContent).toContain("Reading");
    await mounted.render(view([]));
    expect(indicators(mounted.host, "stub")).toHaveLength(0);
  });

  it.each(["minimized", "inline"] as const)(
    "the map reading GitHub shows it %s",
    async (placement) => {
      let reading = true;
      bridge({ map: async () => emptyMap({ reading }) });
      const entry = {
        placement,
        info: {
          address: "local@3#map",
          kind: "map",
          home: "local/main",
          depth: 0,
          opens: null,
          title: "The map",
        },
      } as unknown as Entry;
      const ws = workspace({ entry: () => entry });
      const view = (head: string) =>
        inWorkspace(
          { ...ws, mapHead: head },
          <MapStub message="local@3" conversation="local/main" />,
        );
      mounted = await mount(view("1"));
      expect(indicators(mounted.host, "map")).toHaveLength(0);
      await advance(WORKING_DELAY_MS);
      expect(indicators(mounted.host, "map")).toHaveLength(1);
      expect(indicators(mounted.host, "map")[0]?.textContent).toBe("Reading GitHub");
      reading = false;
      await mounted.render(view("2"));
      await advance(1);
      expect(indicators(mounted.host, "map")).toHaveLength(0);
    },
  );

  it("a context opening shows it in the window that is opening, and not once it has opened", async () => {
    let opened: (boot: Boot) => void = () => {};
    bridge({ boot: () => new Promise<Boot>((resolve) => (opened = resolve)) });
    mounted = await mount(<App />);
    expect(indicators(mounted.host, "context")).toHaveLength(0);
    await advance(WORKING_DELAY_MS);
    expect(indicators(mounted.host, "context")).toHaveLength(1);
    expect(indicators(mounted.host, "context")[0]?.textContent).toBe("Opening this context");
    await act(async () => opened({ kind: "refused", path: "/x", reason: "no" }));
    await advance(1);
    expect(indicators(mounted.host)).toHaveLength(0);
  });

  it("the quiet global place shows it for a turn or a stub being read anywhere, and says which", async () => {
    const view = (busy: number, resolving: string[]) =>
      inWorkspace(
        workspace({
          resolving: new Set(resolving),
          states: {
            "local/main": conversationState({ busy: busy > 0 }),
            "local/t1": conversationState({ conversation: "local/t1", busy: busy > 1 }),
          },
        }),
        <GlobalWorking />,
      );
    mounted = await mount(view(0, []));
    await advance(WORKING_DELAY_MS * 2);
    expect(indicators(mounted.host, "global")).toHaveLength(0);
    await mounted.render(view(2, ["pull-request:a#1"]));
    await advance(WORKING_DELAY_MS);
    expect(indicators(mounted.host, "global")[0]?.textContent).toBe(
      "2 agents are working · Reading 1 status",
    );
    await mounted.render(view(0, []));
    expect(indicators(mounted.host, "global")).toHaveLength(0);
  });

  it("says what is going on in words", () => {
    expect(workingLabel(1, 0)).toBe("An agent is working");
    expect(workingLabel(0, 3)).toBe("Reading 3 statuses");
  });
});
