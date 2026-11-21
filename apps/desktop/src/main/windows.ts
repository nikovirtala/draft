import { join } from "node:path";
import { app, BrowserWindow, screen, shell } from "electron";
import { CHANNELS, type Change } from "../shared/ipc.ts";
import type { Layout } from "../shared/placement.ts";
import type { ViewStateStore } from "./view-state.ts";

const WINDOW_SIZE = { width: 720, height: 600 };

/**
 * The device's real windows: the main one, and one Electron window for every block placed in a
 * window. The layout says which blocks have a window; this keeps the windows in line with it.
 * A person closing a window is a move (the block returns to where it came from); closing one
 * because the layout changed, or because draft quits, is not.
 */
export class WindowManager {
  private main: BrowserWindow | null = null;
  private readonly popped = new Map<string, BrowserWindow>();
  private readonly blockOf = new Map<number, string>();
  /** Windows closed by draft itself: their closing is not a person's move. */
  private readonly closing = new WeakSet<BrowserWindow>();
  private quitting = false;

  constructor(
    private readonly o: {
      preload: string;
      store: () => ViewStateStore | null;
      /** Titles a block's window: what it is and where it came from. */
      titleOf: (block: string) => string;
      /** A person closed a block's window. */
      onClosedByPerson: (block: string) => void;
    },
  ) {}

  private load(win: BrowserWindow, block: string | null): void {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    const query = block === null ? "" : `?block=${encodeURIComponent(block)}`;
    if (!app.isPackaged && devUrl !== undefined) {
      void win.loadURL(`${devUrl}${query}`);
    } else {
      void win.loadFile(join(import.meta.dirname, "../renderer/index.html"), {
        query: block === null ? {} : { block },
      });
    }
  }

  private baseOptions(): Electron.BrowserWindowConstructorOptions {
    return {
      minWidth: 360,
      minHeight: 240,
      backgroundColor: "#f9f1e1",
      show: false,
      webPreferences: {
        preload: this.o.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    };
  }

  private harden(win: BrowserWindow): void {
    // Links never navigate a window: http(s) links open in the system browser for now.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e) => e.preventDefault());
  }

  openMain(): BrowserWindow {
    const win = new BrowserWindow({
      ...this.baseOptions(),
      width: 1120,
      height: 840,
      minWidth: 560,
      minHeight: 480,
      title: "draft",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    });
    this.main = win;
    win.once("ready-to-show", () => win.show());
    this.harden(win);
    // Closing the main window ends draft on every platform but macOS: its windows follow.
    if (process.platform !== "darwin") win.on("close", () => this.beginQuit());
    win.on("closed", () => {
      if (this.main === win) this.main = null;
    });
    this.load(win, null);
    return win;
  }

  hasMain(): boolean {
    return this.main !== null;
  }

  /** Whether draft is ending: windows closing now are not a person's moves. */
  beginQuit(): void {
    this.quitting = true;
  }

  /** The block a window shows, or null for the main window. */
  blockFor(webContentsId: number): string | null {
    return this.blockOf.get(webContentsId) ?? null;
  }

  /** Opens and closes windows so that exactly the blocks placed in a window have one. */
  sync(layout: Layout): void {
    const wanted = new Set(
      Object.values(layout.blocks)
        .filter((e) => e.placement === "window")
        .map((e) => e.info.address),
    );
    for (const [block, win] of this.popped) {
      if (wanted.has(block)) {
        const title = this.o.titleOf(block);
        if (win.getTitle() !== title) win.setTitle(title);
        continue;
      }
      this.closing.add(win);
      this.popped.delete(block);
      this.blockOf.delete(win.webContents.id);
      if (!win.isDestroyed()) win.close();
    }
    for (const block of wanted) if (!this.popped.has(block)) this.open(block);
  }

  private open(block: string): void {
    const saved = this.o.store()?.bounds(block) ?? null;
    const bounds = saved !== null && onScreen(saved) ? saved : null;
    const win = new BrowserWindow({
      ...this.baseOptions(),
      ...WINDOW_SIZE,
      ...(bounds ?? {}),
      title: this.o.titleOf(block),
    });
    // Some platforms clamp a window to the screen when it is made: say where it belongs again.
    if (bounds !== null) win.setBounds(bounds);
    this.popped.set(block, win);
    this.blockOf.set(win.webContents.id, block);
    const id = win.webContents.id;
    // The page's own title never replaces the one that says what the block is.
    win.on("page-title-updated", (e) => e.preventDefault());
    win.once("ready-to-show", () => win.show());
    this.harden(win);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const remember = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win.isDestroyed()) this.o.store()?.setBounds(block, win.getBounds());
      }, 200);
    };
    win.on("resize", remember);
    win.on("move", remember);
    win.on("close", () => {
      // Bounds are kept per device, whoever closes it.
      if (timer !== null) clearTimeout(timer);
      if (!win.isDestroyed()) this.o.store()?.setBounds(block, win.getBounds());
    });
    win.on("closed", () => {
      this.blockOf.delete(id);
      if (this.popped.get(block) === win) this.popped.delete(block);
      if (this.closing.has(win) || this.quitting) return;
      this.o.onClosedByPerson(block);
    });
    this.load(win, block);
  }

  /** Every open window, the main one first. */
  all(): BrowserWindow[] {
    return [...(this.main === null ? [] : [this.main]), ...this.popped.values()].filter(
      (w) => !w.isDestroyed(),
    );
  }

  send(change: Change): void {
    for (const w of this.all()) {
      if (!w.webContents.isDestroyed()) w.webContents.send(CHANNELS.change, change);
    }
  }
}

/** Whether saved bounds still land on a display that is connected now. */
function onScreen(b: { x: number; y: number; width: number; height: number }): boolean {
  try {
    // A display too small to hold a window isn't a screen (a headless run reports 1 by 1): with
    // none to check against, the saved bounds are kept.
    const real = screen
      .getAllDisplays()
      .filter((d) => d.workArea.width >= 200 && d.workArea.height >= 200);
    if (real.length === 0) return true;
    return real.some((d) => {
      const a = d.workArea;
      return (
        b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
      );
    });
  } catch {
    return false;
  }
}
