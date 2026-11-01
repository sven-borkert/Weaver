import type { SelectionBookmark } from "@tiptap/pm/state";
import type { Mapping } from "@tiptap/pm/transform";

export class PendingDocumentUploads {
  private nextId = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): number => this.entries.size;

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
  private readonly entries = new Map<
    number,
    {
      bookmark: SelectionBookmark;
      controller: AbortController;
    }
  >();

  get size(): number {
    return this.entries.size;
  }

  add(bookmark: SelectionBookmark): { id: number; signal: AbortSignal } {
    const id = ++this.nextId;
    const controller = new AbortController();
    this.entries.set(id, { bookmark, controller });
    this.publish();
    return { id, signal: controller.signal };
  }

  map(mapping: Mapping): void {
    for (const entry of this.entries.values())
      entry.bookmark = entry.bookmark.map(mapping);
  }

  complete(id: number): SelectionBookmark | null {
    const entry = this.entries.get(id);
    if (this.entries.delete(id)) this.publish();
    return entry?.bookmark ?? null;
  }

  cancel(): void {
    for (const entry of this.entries.values()) entry.controller.abort();
    this.entries.clear();
    this.publish();
  }
}
