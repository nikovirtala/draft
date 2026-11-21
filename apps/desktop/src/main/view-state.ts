import { DatabaseSync } from "node:sqlite";
import {
  emptyLayout,
  type Layout,
  type PlacementChange,
  parseLayout,
} from "../shared/placement.ts";

/** Where a window was on this device, in screen coordinates. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What this device shows, kept apart from the log: where every block is, which block is in focus,
 * where each window sits and every placement change made. None of it is ever written to the log:
 * placement is per device (a phone could place the same block differently), and moving a block
 * never changes its content.
 *
 * - `layout`: one row with the whole layout (blocks, placements, focus), written together with
 *   the changes that produced it, so the two never disagree.
 * - `moves`: the record of every placement change, for the feedback loop to read later: which
 *   block, its kind, from, to, when and why. Nothing reads it yet.
 * - `window_bounds`: where each block's window was last, kept per block.
 * - `seen`: how many messages of each thread this device has shown.
 */
export class ViewStateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists placements (key text primary key, placement text not null);
      create table if not exists layout (id integer primary key check (id = 1), json text not null);
      create table if not exists moves (
        id integer primary key autoincrement, block text not null, kind text not null,
        from_placement text not null, to_placement text not null, at text not null,
        cause text not null);
      create table if not exists window_bounds (
        block text primary key, x integer not null, y integer not null,
        width integer not null, height integer not null);
      create table if not exists seen (conversation text primary key, messages integer not null);
    `);
  }

  /**
   * Placements from before blocks had a layout, by `<message>#<target>`: inline or minimized.
   * Read once to give a block seen for the first time the place it had; never deleted.
   */
  legacyPlacements(): Record<string, "inline" | "minimized"> {
    const rows = this.db.prepare("select key, placement from placements").all() as {
      key: string;
      placement: string;
    }[];
    return Object.fromEntries(
      rows
        .filter((r) => r.placement === "inline" || r.placement === "minimized")
        .map((r) => [r.key, r.placement as "inline" | "minimized"]),
    );
  }

  layout(): Layout {
    const row = this.db.prepare("select json from layout where id = 1").get() as
      | { json: string }
      | undefined;
    if (row === undefined) return emptyLayout();
    try {
      return parseLayout(JSON.parse(row.json));
    } catch {
      return emptyLayout();
    }
  }

  /** Saves the layout and the changes that led to it in one transaction. */
  commit(layout: Layout, changes: readonly PlacementChange[]): void {
    this.db.exec("begin");
    try {
      this.db
        .prepare(
          "insert into layout values (1, ?) on conflict(id) do update set json = excluded.json",
        )
        .run(JSON.stringify(layout));
      const insert = this.db.prepare("insert into moves values (null, ?, ?, ?, ?, ?, ?)");
      for (const c of changes) insert.run(c.block, c.kind, c.from, c.to, c.at, c.cause);
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  /** Every placement change made on this device, oldest first. */
  moves(): PlacementChange[] {
    return (
      this.db.prepare("select * from moves order by id").all() as Record<string, unknown>[]
    ).map((r) => ({
      block: r.block as string,
      kind: r.kind as string,
      from: r.from_placement as PlacementChange["from"],
      to: r.to_placement as PlacementChange["to"],
      at: r.at as string,
      cause: r.cause as PlacementChange["cause"],
    }));
  }

  bounds(block: string): Bounds | null {
    const r = this.db.prepare("select * from window_bounds where block = ?").get(block) as
      | Record<string, unknown>
      | undefined;
    return r === undefined
      ? null
      : {
          x: Number(r.x),
          y: Number(r.y),
          width: Number(r.width),
          height: Number(r.height),
        };
  }

  setBounds(block: string, b: Bounds): void {
    this.db
      .prepare(
        `insert into window_bounds values (?, ?, ?, ?, ?)
         on conflict(block) do update set x = excluded.x, y = excluded.y,
           width = excluded.width, height = excluded.height`,
      )
      .run(block, Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height));
  }

  seen(): Record<string, number> {
    const rows = this.db.prepare("select conversation, messages from seen").all() as {
      conversation: string;
      messages: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.conversation, Number(r.messages)]));
  }

  setSeen(conversation: string, messages: number): void {
    this.db
      .prepare(
        "insert into seen values (?, ?) on conflict(conversation) do update set messages = excluded.messages",
      )
      .run(conversation, messages);
  }

  close(): void {
    this.db.close();
  }
}
