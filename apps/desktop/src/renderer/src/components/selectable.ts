import type { FocusEvent, PointerEvent } from "react";
import { useWorkspace } from "../workspace.tsx";

/**
 * What makes a block selectable by pointer or keyboard: the focus gesture acts on the block
 * selected last. The innermost block takes the selection, not the one around it.
 */
export function useSelectable(block: string, conversation: string) {
  const ws = useWorkspace();
  const select = (e: PointerEvent | FocusEvent) => {
    e.stopPropagation();
    ws.select({ block, conversation });
  };
  return {
    tabIndex: 0,
    onPointerDown: select,
    onFocus: select,
    "data-selected": ws.selection.block === block,
  } as const;
}
