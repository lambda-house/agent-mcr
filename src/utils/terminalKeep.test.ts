import { describe, expect, it } from 'vitest';
import { TerminalKeep } from './terminalKeep';

describe('kept terminals (MCR-139)', () => {
  it('gives a kept terminal back once, with its offset', () => {
    const dropped: string[] = [];
    const keep = new TerminalKeep<string>(2, t => dropped.push(t));
    keep.put('a', { term: 'A', offset: 10 });
    expect(keep.take('a')).toEqual({ term: 'A', offset: 10 });
    expect(keep.take('a')).toBeUndefined();
    expect(dropped).toEqual([]);
  });

  it('keeps at most max, dropping the least recently hidden', () => {
    const dropped: string[] = [];
    const keep = new TerminalKeep<string>(2, t => dropped.push(t));
    keep.put('a', { term: 'A', offset: 1 });
    keep.put('b', { term: 'B', offset: 1 });
    // Hidden again: the most recent now
    keep.put('a', { term: 'A', offset: 2 });
    keep.put('c', { term: 'C', offset: 1 });
    expect(dropped).toEqual(['B']);
    expect(keep.ids).toEqual(['a', 'c']);
  });

  it('drops the terminals of sessions that left the list, and one it is told to forget', () => {
    const dropped: string[] = [];
    const keep = new TerminalKeep<string>(4, t => dropped.push(t));
    for (const id of ['a', 'b', 'c']) keep.put(id, { term: id.toUpperCase(), offset: null });
    keep.retain(new Set(['b', 'x']));
    expect(dropped.sort()).toEqual(['A', 'C']);
    keep.forget('b');
    expect(keep.ids).toEqual([]);
    expect(dropped.sort()).toEqual(['A', 'B', 'C']);
  });

  it('drops an older terminal of the same session that is replaced', () => {
    const dropped: string[] = [];
    const keep = new TerminalKeep<string>(4, t => dropped.push(t));
    keep.put('a', { term: 'A1', offset: 1 });
    keep.put('a', { term: 'A2', offset: 2 });
    expect(dropped).toEqual(['A1']);
    expect(keep.take('a')?.term).toBe('A2');
  });
});
