/**
 * Terminals of sessions shown a moment ago, kept with what they showed while
 * no pane shows them (MCR-139). A kept terminal is detached from the runner:
 * it parses nothing and renders nothing. Shown again, it asks the runner for
 * the bytes since `offset` and goes on from there, so it keeps every line it
 * had, up to its own scrollback, however long the session's output was; a
 * new terminal gets only what the runner still holds (4 MiB of raw bytes).
 *
 * At most `max` stay live terminals. Beyond that the least recently hidden is
 * compacted: its screen and scrollback serialized as text (a few MB at most,
 * against its buffer's tens), with its size and offset, and the terminal
 * disposed. Shown again, a new terminal is given that text and goes on from
 * the offset in the same way, so an evicted pane loses no line either
 * (review 17084). A session that leaves the list takes its entry with it, and
 * beyond `maxEntries` the least recently hidden entry goes altogether.
 */
export interface Kept<T> {
  /** The live terminal; absent once compacted */
  term?: T;
  /** A compacted terminal: its contents as the serializer wrote them, and its size then */
  text?: string;
  cols?: number;
  rows?: number;
  /** Offset in the session's output of the next byte it has not seen; null when the runner did not say */
  offset: number | null;
}

/** Hidden terminals kept live: each holds up to its scrollback, 10,000 lines */
export const MAX_KEPT = 4;
/** Entries kept at all, live or compacted */
export const MAX_ENTRIES = 32;

export class TerminalKeep<T> {
  private kept = new Map<string, Kept<T>>();

  constructor(
    private max: number,
    /** The text and size of a terminal about to be disposed; null when it cannot be had */
    private compact: (term: T) => { text: string; cols: number; rows: number } | null,
    private drop: (term: T) => void,
    private maxEntries = MAX_ENTRIES,
  ) {}

  /** The kept terminal or text of a session, taken out of the keep (it is shown now) */
  take(id: string): Kept<T> | undefined {
    const k = this.kept.get(id);
    this.kept.delete(id);
    return k;
  }

  /** Keep a hidden terminal; the least recently hidden beyond `max` is compacted */
  put(id: string, kept: Kept<T>) {
    const old = this.kept.get(id);
    if (old?.term && old.term !== kept.term) this.drop(old.term);
    this.kept.delete(id);
    this.kept.set(id, kept);
    for (;;) {
      const live = [...this.kept].filter(([, k]) => k.term);
      if (live.length <= this.max) break;
      const [oldest, k] = live[0];
      const term = k.term as T;
      // Without an offset the text could not be continued: the next show starts over anyway
      const text = k.offset === null ? null : this.compact(term);
      this.drop(term);
      if (text) this.kept.set(oldest, { ...text, offset: k.offset });
      else this.kept.delete(oldest);
    }
    while (this.kept.size > this.maxEntries) this.forget(this.kept.keys().next().value as string);
  }

  /** Drop the kept terminals of sessions that are not in `ids` */
  retain(ids: Set<string>) {
    for (const id of [...this.kept.keys()]) if (!ids.has(id)) this.forget(id);
  }

  /** Drop what is kept of one session */
  forget(id: string) {
    const k = this.kept.get(id);
    this.kept.delete(id);
    if (k?.term) this.drop(k.term);
  }

  get ids(): string[] { return [...this.kept.keys()]; }
  /** The sessions kept as live terminals */
  get live(): string[] { return [...this.kept].filter(([, k]) => k.term).map(([id]) => id); }
}
