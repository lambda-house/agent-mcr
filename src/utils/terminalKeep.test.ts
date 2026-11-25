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

  it('exempts all assigned panes from the four-terminal limit until the layout releases them', () => {
    const dropped: string[] = [];
    const keep = new TerminalKeep<string>(4, term => dropped.push(term));
    const panes = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    keep.protect(new Set(panes));
    for (const id of [...panes, 'a', 'b', 'c', 'd', 'e']) keep.put(id, { term: id, offset: 10 });
    expect(keep.ids).toEqual([...panes, 'b', 'c', 'd', 'e']);
    expect(dropped).toEqual(['a']);

    keep.protect(new Set(panes.slice(2)));
    expect(keep.ids).toEqual([...panes.slice(2), 'b', 'c', 'd', 'e']);
    expect(dropped).toEqual(['a', 'p1', 'p2']);
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

  it('does not spend a slot on a closed terminal when its pane detaches', () => {
    const dropped: string[] = [];
    const keep = new TerminalKeep<string>(1, t => dropped.push(t));
    keep.retain(new Set(['running', 'closed']));
    keep.protect(new Set(['closed']));
    keep.put('running', { term: 'live output', offset: 1 });
    keep.forget('closed');
    keep.protect(new Set());
    keep.put('closed', { term: 'closed output', offset: 1 });
    expect(dropped).toEqual(['closed output']);
    expect(keep.ids).toEqual(['running']);
  });

  it('never takes back a session that left the list, also when its terminal is put after that (review 17088)', () => {
    const dropped: string[] = [];
    const keep = new TerminalKeep<string>(4, t => dropped.push(t));
    keep.retain(new Set(['a', 'b']));
    keep.retain(new Set(['b']));
    // The terminal of 'a' finished parsing only now
    keep.put('a', { term: 'A', offset: 1 });
    expect(keep.ids).toEqual([]);
    expect(dropped).toEqual(['A']);
    // A session that was never in a list (started since) is kept
    keep.put('c', { term: 'C', offset: 1 });
    expect(keep.ids).toEqual(['c']);
  });
});
