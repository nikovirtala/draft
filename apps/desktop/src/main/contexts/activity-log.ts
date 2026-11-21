import type { DraftEvent, EventDraft, LogRecord, LogStore } from "@nikovirtala/draft-core";

/** A log that tells the registry when something was written, so "last activity" is always current. */
export class ActivityLog implements LogStore {
  constructor(
    private readonly inner: LogStore,
    private readonly written: (at: string) => void,
  ) {}

  async append(drafts: readonly EventDraft[]): Promise<DraftEvent[]> {
    const sealed = await this.inner.append(drafts);
    const last = sealed.at(-1);
    if (last !== undefined) this.written(last.at);
    return sealed;
  }

  events(): readonly LogRecord[] {
    return this.inner.events();
  }

  head(): string {
    return this.inner.head();
  }

  close(): void {
    this.inner.close();
  }
}
