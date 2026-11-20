import { type RefObject, useEffect } from "react";
import type { ConversationState } from "../../shared/ipc.ts";

/**
 * Tells the main process which stubs are on screen, so only those are polled. Watches every
 * element with a `data-stub-target` attribute inside the conversation column.
 */
export function useVisibleStubs(
  root: RefObject<HTMLElement | null>,
  state: ConversationState | null,
): void {
  const key = state === null ? "" : state.messages.map((m) => m.references.length).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe when references change
  useEffect(() => {
    const container = root.current;
    if (container === null) return;
    const visible = new Set<string>();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      pending = null;
      const targets = [...visible].map((t) => {
        const [type, ...rest] = t.split(":");
        return { type: type as string, id: rest.join(":") };
      });
      window.draft.setVisible(targets);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const target = (e.target as HTMLElement).dataset.stubTarget;
          if (target === undefined) continue;
          if (e.isIntersecting) visible.add(target);
          else visible.delete(target);
        }
        pending ??= setTimeout(flush, 100);
      },
      { root: container },
    );
    for (const el of container.querySelectorAll<HTMLElement>("[data-stub-target]"))
      observer.observe(el);
    return () => {
      observer.disconnect();
      if (pending !== null) clearTimeout(pending);
    };
  }, [root, key]);
}
