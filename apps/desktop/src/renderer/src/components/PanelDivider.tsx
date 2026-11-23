import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  clampPanelWidth,
  PANEL_MIN,
  PANEL_STEP,
  PANEL_STEP_LARGE,
  panelMax,
} from "../../../shared/frame.ts";

/** What the divider takes between the columns, so the two widths add up to the window's. */
export const DIVIDER_WIDTH = 8;

/**
 * The width of the thread's column: what the person set (kept per device in the view state) or,
 * while they haven't, the default the stylesheet gives. `width` is what is on screen now, in
 * pixels, whether it was set or measured; `style` is what to put on the grid to apply a set width.
 */
export function usePanelWidth(
  grid: RefObject<HTMLElement | null>,
  stored: number | null,
  open: boolean,
): {
  width: number | null;
  max: number;
  set: (px: number) => void;
  commit: (px: number) => void;
  /** Back to the default width, and the stored one forgotten. */
  reset: () => void;
  style: CSSProperties | undefined;
} {
  const [width, setWidth] = useState<number | null>(stored);
  const [available, setAvailable] = useState(0);
  const [measured, setMeasured] = useState<number | null>(null);
  const [epoch, setEpoch] = useState(0);
  const latest = useRef(width);
  latest.current = width;

  // The room both columns have, and the width the default gives the thread's column. It reads
  // again when the panel opens or closes, which `open` says, and after a reset, which `epoch` says.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` and `epoch` only say when to read again
  useEffect(() => {
    const el = grid.current;
    if (el === null) return;
    const read = () => {
      setAvailable(el.clientWidth - DIVIDER_WIDTH);
      const panel = el.querySelector<HTMLElement>('[data-testid="panel"]');
      setMeasured(panel === null ? null : Math.round(panel.getBoundingClientRect().width));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [grid, open, epoch]);

  const limit = available > 0 ? available : Number.POSITIVE_INFINITY;
  const shown = width === null ? measured : clampPanelWidth(width, limit);
  const set = useCallback((px: number) => setWidth(px), []);
  const commit = useCallback((px: number) => {
    setWidth(px);
    void window.draft.setPanelWidth(px);
  }, []);
  const reset = useCallback(() => {
    setWidth(null);
    setEpoch((n) => n + 1);
    void window.draft.setPanelWidth(null);
  }, []);
  return {
    width: shown,
    max: panelMax(limit),
    set,
    commit,
    reset,
    style:
      width === null
        ? undefined
        : { gridTemplateColumns: `minmax(0, 1fr) ${DIVIDER_WIDTH}px ${shown}px` },
  };
}

/**
 * The divider between the conversation and the thread: a separator the pointer drags and the
 * arrow keys move. Its value is the thread column's width in pixels, so Left makes the thread
 * wider (the divider moves left) and Right narrower. Shift moves it by more; Home and End go to
 * the narrowest and the widest the window allows. The width is kept when the pointer lets go or a
 * key moves it. A double-click returns the column to its default and forgets the kept width.
 */
export function PanelDivider({
  grid,
  panel,
}: {
  grid: RefObject<HTMLElement | null>;
  panel: ReturnType<typeof usePanelWidth>;
}) {
  const dragging = useRef(false);
  const widthAt = (e: PointerEvent): number => {
    const box = grid.current?.getBoundingClientRect();
    if (box === undefined) return PANEL_MIN;
    return clampPanelWidth(box.right - e.clientX - DIVIDER_WIDTH / 2, box.width - DIVIDER_WIDTH);
  };
  const onKey = (e: KeyboardEvent) => {
    const now = panel.width ?? PANEL_MIN;
    const step = e.shiftKey ? PANEL_STEP_LARGE : PANEL_STEP;
    const next =
      e.key === "ArrowLeft"
        ? now + step
        : e.key === "ArrowRight"
          ? now - step
          : e.key === "Home"
            ? PANEL_MIN
            : e.key === "End"
              ? panel.max
              : null;
    if (next === null) return;
    e.preventDefault();
    panel.commit(Math.round(Math.min(panel.max, Math.max(PANEL_MIN, next))));
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't take focus or a value; a splitter is a focusable separator.
    <div
      className="panel-divider"
      data-testid="panel-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Thread width"
      aria-valuenow={panel.width ?? undefined}
      aria-valuemin={PANEL_MIN}
      aria-valuemax={panel.max}
      tabIndex={0}
      onKeyDown={onKey}
      onDoubleClick={() => panel.reset()}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (dragging.current) panel.set(widthAt(e));
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        panel.commit(widthAt(e));
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    />
  );
}
