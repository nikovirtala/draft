import type { DraftBridge } from "../../shared/ipc.ts";

declare global {
  interface Window {
    draft: DraftBridge;
  }
}
