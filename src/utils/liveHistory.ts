/**
 * Back and Forward in the Live view (MCR-108): the order in which sessions
 * were shown, browser style. Pure, so that the rules can be tested apart
 * from the view.
 */
export interface LiveHistory {
  /** Session ids, oldest first */
  entries: string[];
  /** Where the view stands in `entries`; -1 when nothing was shown yet */
  index: number;
}

export const EMPTY_HISTORY: LiveHistory = { entries: [], index: -1 };

/** How many places the history keeps; the oldest go first. */
export const MAX_HISTORY = 50;

/**
 * The view went to `id`. Going to the session already shown changes
 * nothing; going somewhere new after a Back drops what was ahead, as a
 * browser does.
 */
export function visit(history: LiveHistory, id: string): LiveHistory {
  if (!id || history.entries[history.index] === id) return history;
  const entries = [...history.entries.slice(0, history.index + 1), id].slice(-MAX_HISTORY);
  return { entries, index: entries.length - 1 };
}

/**
 * The place Back (`-1`) or Forward (`1`) leads to: the nearest one on that
 * side whose session still runs and is not the one shown. `null` when there
 * is none, and the button is disabled.
 */
export function step(history: LiveHistory, direction: -1 | 1, running: (id: string) => boolean): number | null {
  const shown = history.entries[history.index];
  for (let i = history.index + direction; i >= 0 && i < history.entries.length; i += direction) {
    if (history.entries[i] !== shown && running(history.entries[i])) return i;
  }
  return null;
}

/** A restarted session got a new id: it keeps its places under that id. */
export function renamed(history: LiveHistory, from: string, to: string): LiveHistory {
  return history.entries.includes(from) ? { ...history, entries: history.entries.map(id => id === from ? to : id) } : history;
}
