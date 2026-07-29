// Glasses relay item queue (#504) — domain layer, no I/O.
//
// The queue is the central UI model of the glasses app: messages that need a
// decision (waiting items) always come first, info items (FYI with TTL) trail behind.
// It holds only ACTIVE items: dismissed upserts are dropped, and
// `glasses-relay-remove` deletes outright.

import type { GlassesRelayItem } from './types.ts'

export class RelayQueue {
  private items = new Map<string, GlassesRelayItem>()

  /** Replace the whole queue from a `glasses-relay-snapshot`. */
  applySnapshot(items: GlassesRelayItem[]): void {
    this.items.clear()
    for (const item of items) {
      if (!item.dismissed) this.items.set(item.id, item)
    }
  }

  /** Apply a `glasses-relay` upsert. Returns true when this is a NEW active
   *  item (used to trigger the proactive overlay). Dismissed reflections are
   *  removals from the active queue. */
  upsert(item: GlassesRelayItem): boolean {
    if (item.dismissed) {
      this.items.delete(item.id)
      return false
    }
    const isNew = !this.items.has(item.id)
    this.items.set(item.id, item)
    return isNew
  }

  /** Apply a `glasses-relay-remove` (exit-blocked / TTL expiry). Returns true
   *  when the item was present. */
  remove(id: string): boolean {
    return this.items.delete(id)
  }

  /** All active items, waiting-first: waiting FIFO (oldest blocked first),
   *  then info newest-first. */
  sorted(): GlassesRelayItem[] {
    const waiting: GlassesRelayItem[] = []
    const info: GlassesRelayItem[] = []
    for (const item of this.items.values()) {
      ;(item.kind === 'waiting' ? waiting : info).push(item)
    }
    waiting.sort((a, b) => a.createdAt - b.createdAt)
    info.sort((a, b) => b.createdAt - a.createdAt)
    return [...waiting, ...info]
  }

  waitingItems(): GlassesRelayItem[] {
    return this.sorted().filter((i) => i.kind === 'waiting')
  }

  infoItems(): GlassesRelayItem[] {
    return this.sorted().filter((i) => i.kind === 'info')
  }

  /** Highest-priority waiting item — the one shown in the overlay. */
  topWaiting(): GlassesRelayItem | undefined {
    return this.waitingItems()[0]
  }

  get(id: string): GlassesRelayItem | undefined {
    return this.items.get(id)
  }

  /** Active waiting items for one session (usually 0 or 1). */
  waitingForSession(sessionId: string): GlassesRelayItem | undefined {
    return this.waitingItems().find((i) => i.sessionId === sessionId)
  }

  get waitingCount(): number {
    let n = 0
    for (const item of this.items.values()) if (item.kind === 'waiting') n++
    return n
  }

  get size(): number {
    return this.items.size
  }
}
