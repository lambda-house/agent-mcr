/**
 * Terminals of sessions shown a moment ago, kept with what they showed while
 * no pane shows them (MCR-139). A kept terminal is detached from the runner:
 * it parses nothing and renders nothing. Shown again, it asks the runner for
 * the bytes since `offset` and goes on from there, so it keeps every line it
 * had, up to its own scrollback, however long the session's output was; a
 * new terminal gets only what the runner still holds (4 MiB of raw bytes).
 *
 * At most `max` are kept, the least recently hidden going first, and a kept
 * terminal of a session that left the list goes at once. A session whose
 * terminal went gets a new one with the runner's replay, as every switch did
 * before MCR-139. Keeping a dropped terminal's contents as serialized text was
 * tried and taken out (review 17086): xterm serializes only what it parsed,
 * and an offset in the middle of an escape sequence cannot be continued from
 * text, so lines were lost or garbled.
 */
export interface Kept<T> {
  term: T;
  /** Offset in the session's output of the next byte it has not seen; null when the runner did not say */
  offset: number | null;
}

/** As many hidden terminals as kept: each holds up to its scrollback, 10,000 lines */
export const MAX_KEPT = 4;

export class TerminalKeep<T> {
  private kept = new Map<string, Kept<T>>();
  /** The sessions of the last list, and those that were in a list and left it: never kept again */
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
   * Keep a hidden terminal; the least recently hidden beyond `max` is dropped.
   * One of a session that left the list is dropped at once: a terminal is put
   * when xterm has parsed its last bytes, which can be after the list let the
   * session go (review 17088).
   */
  put(id: string, kept: Kept<T>) {
    if (this.gone.has(id)) { this.drop(kept.term); return; }
    const old = this.kept.get(id);
    if (old && old.term !== kept.term) this.drop(old.term);
    this.kept.delete(id);
    this.kept.set(id, kept);
    while (this.kept.size > this.max) {
      const [first, k] = this.kept.entries().next().value as [string, Kept<T>];
      this.kept.delete(first);
      this.drop(k.term);
    }
  }

  /** Drop the kept terminals of sessions that are not in `ids`, the list now */
  retain(ids: Set<string>) {
    for (const id of this.listed) if (!ids.has(id)) this.gone.add(id);
    this.listed = new Set(ids);
    for (const [id, k] of [...this.kept]) if (!ids.has(id)) { this.kept.delete(id); this.drop(k.term); }
  }

  /** Drop the kept terminal of one session */
  forget(id: string) {
    const k = this.kept.get(id);
    if (k) { this.kept.delete(id); this.drop(k.term); }
  }

  get ids(): string[] { return [...this.kept.keys()]; }
}
