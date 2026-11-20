import { describe, expect, it } from 'vitest';
import { EMPTY_HISTORY, MAX_HISTORY, renamed, step, visit, type LiveHistory } from './liveHistory';

const go = (...ids: string[]) => ids.reduce(visit, EMPTY_HISTORY);
const all = () => true;

describe('the Live view\'s history (MCR-108)', () => {
  it('keeps the order of what was shown, and going to the shown session adds nothing', () => {
    expect(go('a', 'b', 'b', 'c')).toEqual({ entries: ['a', 'b', 'c'], index: 2 });
    expect(visit(go('a'), '')).toEqual(go('a'));
  });

  it('goes back and forward, and a new place after Back drops what was ahead', () => {
    const h = go('a', 'b', 'c');
    expect(step(h, -1, all)).toBe(1);
    expect(step(h, 1, all)).toBeNull();
    const back: LiveHistory = { ...h, index: 1 };
    expect(step(back, 1, all)).toBe(2);
    expect(visit(back, 'd')).toEqual({ entries: ['a', 'b', 'd'], index: 2 });
    expect(step(EMPTY_HISTORY, -1, all)).toBeNull();
  });

  it('passes over sessions that ended, and over the shown one met again', () => {
    const h = go('a', 'b', 'c', 'b', 'd');
    const running = (id: string) => id !== 'c';
    // From d: b (index 3) is nearest and running
    expect(step(h, -1, running)).toBe(3);
    // From b at index 3: c ended, b is the shown one, a is next
    expect(step({ ...h, index: 3 }, -1, running)).toBe(0);
    expect(step({ ...h, index: 3 }, 1, running)).toBe(4);
    // Nothing running on that side: disabled
    expect(step({ ...h, index: 3 }, -1, id => id === 'b')).toBeNull();
  });

  it('keeps at most so many places, the newest', () => {
    const many = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => `s${i}`);
    const h = go(...many);
    expect(h.entries).toHaveLength(MAX_HISTORY);
    expect(h.entries[0]).toBe('s10');
    expect(h.index).toBe(MAX_HISTORY - 1);
  });

  it('follows a restarted session to its new id', () => {
    expect(renamed(go('a', 'b', 'a'), 'a', 'a2')).toEqual({ entries: ['a2', 'b', 'a2'], index: 2 });
    const h = go('a');
    expect(renamed(h, 'x', 'y')).toBe(h);
  });
});
