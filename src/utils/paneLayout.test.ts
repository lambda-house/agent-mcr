import { describe, expect, it } from 'vitest';
import { leaves, splitLeaf, type LayoutNode } from '@lambda-house/workbench';
import {
  addSlot,
  clearItems,
  findLeafByItem,
  isSlot,
  itemOf,
  paneOf,
  presetLayout,
  removeSessionFromLayout,
  replaceSessionInLayout,
  setLeafItem,
  slotsOf,
  type PaneItem,
} from './paneLayout';
import { defaultLayout } from '../sessionsLayout';

const s = (id: string): PaneItem => ({ kind: 'session', id });
const d = (key: string): PaneItem => ({ kind: 'custom', type: 'note', key });
/** What each leaf shows: an item, the empty pane, or the list or a panel by its type. */
const shows = (root: LayoutNode) => leaves(root).map(l => itemOf(l.pane) ?? l.pane?.type);

describe('Live’s panes', () => {
  it('shows sessions and plugin panes in the panes a session can open in, and empties them', () => {
    let tree = setLeafItem(defaultLayout('live'), 'p1', s('s1'));
    tree = splitLeaf(tree, 'p1', 'row', 'after', { kind: 'leaf', id: 'p2', pane: paneOf(d('/work/README.md')) }, 'sp1');
    expect(shows(tree)).toEqual(['live-sessions', s('s1'), d('/work/README.md')]);
    expect(findLeafByItem(tree, d('/work/README.md'))?.id).toBe('p2');
    // The list is no such pane; an empty pane is
    expect(slotsOf(tree).map(l => l.id)).toEqual(['p1', 'p2']);
    expect(isSlot(leaves(tree)[0])).toBe(false);
    tree = setLeafItem(tree, 'p2', null);
    expect(shows(tree)).toEqual(['live-sessions', s('s1'), 'empty']);
    expect(slotsOf(tree).map(l => l.id)).toEqual(['p1', 'p2']);
    // Emptying an empty pane changes nothing
    expect(setLeafItem(tree, 'p2', null)).toBe(tree);
  });

  it('gives a restarted session its old pane, and empties the panes of sessions that went', () => {
    let tree = setLeafItem(defaultLayout('live'), 'p1', s('s1'));
    tree = replaceSessionInLayout(tree, 's1', 's1-new');
    expect(findLeafByItem(tree, s('s1-new'))?.id).toBe('p1');
    expect(findLeafByItem(tree, s('s1'))).toBeUndefined();
    tree = removeSessionFromLayout(tree, 's1-new');
    expect(shows(tree)).toEqual(['live-sessions', 'empty']);
    tree = clearItems(setLeafItem(tree, 'p1', d('/a.md')), item => item.kind === 'custom');
    expect(shows(tree)).toEqual(['live-sessions', 'empty']);
  });

  it('adds a pane beside the list when none can take a session', () => {
    const onlyPanels: LayoutNode = { kind: 'split', id: 'live', dir: 'row', children: [{ kind: 'leaf', id: 'list', pane: { type: 'live-sessions', key: 'live-sessions' } }, { kind: 'leaf', id: 'r', pane: { type: 'board-reports', key: 'board-reports' } }], sizes: [{ px: 290 }, { fr: 1 }] };
    expect(slotsOf(onlyPanels)).toEqual([]);
    const tree = addSlot(onlyPanels, 'p9', s('a'));
    expect(shows(tree)).toEqual(['live-sessions', s('a'), 'board-reports']);
  });

  it('builds the presets beside the list as it was, and brings the list back', () => {
    const narrow: LayoutNode = { ...defaultLayout('live'), sizes: [{ px: 250 }, { fr: 1 }] } as LayoutNode;
    const two = presetLayout(narrow, '2-col', [s('a'), d('/b.md')]);
    expect(shows(two.root)).toEqual(['live-sessions', s('a'), d('/b.md')]);
    expect(two.root).toMatchObject({ kind: 'split', dir: 'row', sizes: [{ px: 250 }, { fr: 0.5 }, { fr: 0.5 }] });
    expect(itemOf(leaves(two.root).find(l => l.id === two.focused)?.pane)).toEqual(s('a'));

    const four = presetLayout(narrow, '2x2', [s('a'), d('/b.md'), s('c')]);
    expect(shows(four.root)).toEqual(['live-sessions', s('a'), d('/b.md'), s('c'), 'empty']);

    // Without the list (its pane closed): it comes back at its width
    const withoutList: LayoutNode = { kind: 'leaf', id: 'p1', pane: paneOf(s('a')) };
    const one = presetLayout(withoutList, '1', [s('a')]);
    expect(shows(one.root)).toEqual(['live-sessions', s('a')]);
    expect(one.root).toMatchObject({ sizes: [{ px: 290 }, { fr: 1 }] });
  });
});
