/**
 * A detached terminal keeps its parser, pending writes and scrollback. On
 * reattach it asks for the bytes since `offset` and appends them to its write
 * queue. If the runner cannot continue at that offset, a fresh terminal
 * consumes the full replay the runner still holds on that same connection.
 *
 * Terminals still assigned to a pane are protected even when the pane is
 * clipped or zero-sized (MCR-140). Of the others, at most `max` are kept,
 * the least recently detached going first. Closing a session or removing it
 * from the list drops its terminal at once. Other evicted terminals start
 * over with the runner's replay. Saving
 * serialized text lost parser state for unfinished escape sequences (review
 * 17086), so the keep holds the xterm itself.
 */
export interface Kept<T> {
  term: T;
  /** Offset after all bytes handed to xterm, including queued writes; null when the runner did not say */
  offset: number | null;
}

/** Maximum unassigned terminals kept, each with up to 10,000 scrollback lines. */
export const MAX_KEPT = 4;

export class TerminalKeep<T> {
  private kept = new Map<string, Kept<T>>();
  private assigned: ReadonlySet<string> = new Set();
  /** The last list, and sessions that closed or left the list: never kept again */
  private listed = new Set<string>();
  private gone = new Set<string>();

  constructor(private max: number, private drop: (term: T) => void) {}

  /** The kept terminal of a session, taken out of the keep (it is shown now) */
  take(id: string): Kept<T> | undefined {
    const k = this.kept.get(id);
    this.kept.delete(id);
    return k;
  }

  /**
   * Keep a detached terminal. The least recently detached unassigned one
   * beyond `max` is dropped, as is a session the list already removed.
   */
  put(id: string, kept: Kept<T>) {
    if (this.gone.has(id)) { this.drop(kept.term); return; }
    const old = this.kept.get(id);
    if (old && old.term !== kept.term) this.drop(old.term);
    this.kept.delete(id);
    this.kept.set(id, kept);
    this.trim();
  }

  /** Update which sessions are still in the pane layout before detaching views. */
  protect(ids: ReadonlySet<string>) {
    this.assigned = ids;
    this.trim();
  }

  private trim() {
    const unassigned = [...this.kept.keys()].filter(id => !this.assigned.has(id));
    for (const id of unassigned.slice(0, Math.max(0, unassigned.length - this.max))) this.evict(id);
  }

  /** Drop the kept terminals of sessions that are not in `ids`, the list now */
  retain(ids: Set<string>) {
    for (const id of this.listed) if (!ids.has(id)) this.forget(id);
    this.listed = new Set(ids);
    for (const id of this.kept.keys()) if (!ids.has(id)) this.evict(id);
  }

  /** Release the terminal even if its pane has yet to detach and put it back. */
  forget(id: string) {
    this.gone.add(id);
    this.evict(id);
  }

  private evict(id: string) {
    const k = this.kept.get(id);
    this.kept.delete(id);
    if (k) this.drop(k.term);
  }

  get ids(): string[] { return [...this.kept.keys()]; }
}
