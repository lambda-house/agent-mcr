import { describe, expect, it } from 'vitest';
import { TerminalKeep } from './terminalKeep';

/** Terminals are strings here; compacting one gives its text, at 100×30 */
const make = (max: number, maxEntries?: number) => {
  const dropped: string[] = [];
  const keep = new TerminalKeep<string>(max, t => ({ text: `text of ${t}`, cols: 100, rows: 30 }), t => dropped.push(t), maxEntries);
  return { keep, dropped };
};

describe('kept terminals (MCR-139)', () => {
  it('gives a kept terminal back once, with its offset', () => {
    const { keep, dropped } = make(2);
    keep.put('a', { term: 'A', offset: 10 });
    expect(keep.take('a')).toEqual({ term: 'A', offset: 10 });
    expect(keep.take('a')).toBeUndefined();
    expect(dropped).toEqual([]);
  });

  it('keeps at most max live, compacting the least recently hidden instead of losing it (review 17084)', () => {
    const { keep, dropped } = make(2);
    keep.put('a', { term: 'A', offset: 1 });
    keep.put('b', { term: 'B', offset: 7 });
    // Hidden again: the most recent now
    keep.put('a', { term: 'A', offset: 2 });
    keep.put('c', { term: 'C', offset: 1 });
    // B's terminal is disposed, its contents and offset stay
    expect(dropped).toEqual(['B']);
    expect(keep.live).toEqual(['a', 'c']);
    expect(keep.take('b')).toEqual({ text: 'text of B', cols: 100, rows: 30, offset: 7 });
  });

  it('drops outright a terminal whose offset is not known: its text could not be continued', () => {
    const { keep, dropped } = make(1);
    keep.put('a', { term: 'A', offset: null });
    keep.put('b', { term: 'B', offset: 3 });
    expect(dropped).toEqual(['A']);
    expect(keep.ids).toEqual(['b']);
  });

  it('keeps at most maxEntries in all, the least recently hidden going first', () => {
    const { keep } = make(1, 3);
    for (const id of ['a', 'b', 'c', 'd']) keep.put(id, { term: id.toUpperCase(), offset: 1 });
    expect(keep.ids).toEqual(['b', 'c', 'd']);
    expect(keep.live).toEqual(['d']);
  });

  it('drops what is kept of sessions that left the list, and of one it is told to forget', () => {
    const { keep, dropped } = make(2);
    for (const id of ['a', 'b', 'c']) keep.put(id, { term: id.toUpperCase(), offset: 1 });
    // 'a' is compacted by now: its terminal was disposed then
    expect(dropped).toEqual(['A']);
    keep.retain(new Set(['b', 'x']));
    expect(keep.ids).toEqual(['b']);
    expect(dropped.sort()).toEqual(['A', 'C']);
    keep.forget('b');
    expect(keep.ids).toEqual([]);
    expect(dropped.sort()).toEqual(['A', 'B', 'C']);
  });

  it('drops an older terminal of the same session that is replaced', () => {
    const { keep, dropped } = make(4);
    keep.put('a', { term: 'A1', offset: 1 });
    keep.put('a', { term: 'A2', offset: 2 });
    expect(dropped).toEqual(['A1']);
    expect(keep.take('a')?.term).toBe('A2');
  });
});
