import { DatabaseSync } from "node:sqlite";
import type { Placement } from "../shared/ipc.ts";

/**
 * Placement of blocks on this device. View state, kept apart from the log: moving a block never
 * changes its content, and a phone could place the same block differently.
 */
export class ViewStateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "create table if not exists placements (key text primary key, placement text not null)",
    );
  }

  all(): Record<string, Placement> {
    const rows = this.db.prepare("select key, placement from placements").all() as {
      key: string;
      placement: Placement;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.placement]));
  }

  set(key: string, placement: Placement): void {
    this.db
      .prepare(
        "insert into placements values (?, ?) on conflict(key) do update set placement = excluded.placement",
      )
      .run(key, placement);
  }

  close(): void {
    this.db.close();
  }
}
