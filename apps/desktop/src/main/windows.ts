import { join } from "node:path";
import { app, BrowserWindow, screen, shell } from "electron";
import { CHANNELS, type Change } from "../shared/ipc.ts";
import { PAGE_BACKGROUND } from "../shared/palette.ts";
import type { Layout } from "../shared/placement.ts";
import type { ViewStateStore } from "./view-state.ts";

const WINDOW_SIZE = { width: 720, height: 600 };

/** Where the main window's bounds are kept among a context's window bounds. */
const MAIN_KEY = "@main";

/**
 * One context's real windows: its main one, and one Electron window for every block placed in a
 * window (ADR 4e115peq). The layout says which blocks have a window; this keeps the windows in line with it.
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
  private mainId: number | null = null;

  constructor(
    private readonly o: {
      preload: string;
      store: () => ViewStateStore | null;
      /** Titles a block's window: what it is and where it came from. */
      titleOf: (block: string) => string;
      /** The main window's title: draft and the context it shows. */
      mainTitle: string;
      /** How far to offset a main window that has no saved place, so contexts don't stack. */
      cascade: number;
      /** A person closed a block's window. */
      onClosedByPerson: (block: string) => void;
      /** A person closed the main window: the context ends. */
      onMainClosed: () => void;
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
      backgroundColor: PAGE_BACKGROUND,
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
    const saved = this.o.store()?.bounds(MAIN_KEY) ?? null;
    const bounds = saved !== null && onScreen(saved) ? saved : null;
    const win = new BrowserWindow({
      ...this.baseOptions(),
      width: 1120,
      height: 840,
      minWidth: 560,
      minHeight: 480,
      title: this.o.mainTitle,
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      ...(bounds ?? {}),
    });
    if (bounds === null && this.o.cascade > 0) {
      const b = win.getBounds();
      win.setPosition(b.x + this.o.cascade, b.y + this.o.cascade);
    } else if (bounds !== null) win.setBounds(bounds);
    this.main = win;
    this.mainId = win.webContents.id;
    win.on("page-title-updated", (e) => e.preventDefault());
    win.once("ready-to-show", () => win.show());
    this.harden(win);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const remember = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win.isDestroyed()) this.o.store()?.setBounds(MAIN_KEY, win.getBounds());
      }, 200);
    };
    win.on("resize", remember);
    win.on("move", remember);
    win.on("close", () => {
      if (timer !== null) clearTimeout(timer);
      if (!win.isDestroyed()) this.o.store()?.setBounds(MAIN_KEY, win.getBounds());
    });
    win.on("closed", () => {
      if (this.main === win) this.main = null;
      if (this.quitting) return;
      // Closing a context's main window ends that context; its block windows follow.
      this.shutdown();
      this.o.onMainClosed();
    });
    this.load(win, null);
    return win;
  }

  /** Brings the main window forward, for a context that is open already. */
  focus(): void {
    const win = this.main;
    if (win === null || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** Whether a window of this context has this web contents. */
  owns(webContentsId: number): boolean {
    return this.mainId === webContentsId || this.blockOf.has(webContentsId);
  }

  /** Closes every block window without treating it as a person's move. */
  shutdown(): void {
    this.quitting = true;
    for (const [block, win] of this.popped) {
      this.closing.add(win);
      this.popped.delete(block);
      this.blockOf.delete(win.webContents.id);
      if (!win.isDestroyed()) win.close();
    }
  }

  /** Closes the main window too, when draft ends the context itself. */
  close(): void {
    this.shutdown();
    const win = this.main;
    this.main = null;
    if (win !== null && !win.isDestroyed()) win.destroy();
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

  /** Sends a change to every window, except the one with web contents `except`. */
  send(change: Change, except?: number): void {
    for (const w of this.all()) {
      if (w.webContents.id === except) continue;
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
