import { useEffect } from "react";

/**
 * Tells the main process which stubs are on screen in this window, so only those are polled.
 * Watches every element with a `data-stub-target` attribute, wherever it is: the conversation,
 * a thread in the panel or a window.
 */
export function useVisibleStubs(): void {
  useEffect(() => {
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
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const target = (e.target as HTMLElement).dataset.stubTarget;
        if (target === undefined) continue;
        if (e.isIntersecting) visible.add(target);
        else visible.delete(target);
      }
      pending ??= setTimeout(flush, 100);
    });
    const watch = () => {
      // Observing an element twice is a no-op, so this can run for every change.
      for (const el of document.querySelectorAll<HTMLElement>("[data-stub-target]"))
        observer.observe(el);
    };
    watch();
    const mutations = new MutationObserver(watch);
    mutations.observe(document.body, { childList: true, subtree: true });
    return () => {
      mutations.disconnect();
      observer.disconnect();
      if (pending !== null) clearTimeout(pending);
    };
  }, []);
}
