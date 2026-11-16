import { describe, expect, it } from 'vitest';
import {
  applyLayoutPreset,
  closeLeaf,
  createInitialLayout,
  findLeafByItem,
  listLeaves,
  removeDocFromLayout,
  removeSessionFromLayout,
  replaceSessionInLayout,
  setLeafItem,
  setSplitRatio,
  splitLeaf,
  type PaneItem,
} from './paneLayout';

const s = (id: string): PaneItem => ({ kind: 'session', id });
const d = (path: string): PaneItem => ({ kind: 'doc', path });

describe('paneLayout', () => {
  it('splits a leaf between sessions and documents, and collapses back cleanly on close', () => {
    let tree = setLeafItem(createInitialLayout(), 'p1', s('s1'));
    tree = splitLeaf(tree, 'p1', 'row', 'p2', 'sp1', d('/work/README.md'));

    expect(listLeaves(tree).map(l => [l.id, l.item])).toEqual([
      ['p1', s('s1')],
      ['p2', d('/work/README.md')],
    ]);
    expect(findLeafByItem(tree, d('/work/README.md'))?.id).toBe('p2');

    const collapsed = closeLeaf(tree, 'p1');
    expect(collapsed.kind).toBe('leaf');
    expect(listLeaves(collapsed)).toEqual([{ kind: 'leaf', id: 'p2', item: d('/work/README.md') }]);
  });

  it('clamps split ratios and updates/removes sessions and docs', () => {
    let tree = splitLeaf(setLeafItem(createInitialLayout(), 'p1', s('s1')), 'p1', 'col', 'p2', 'sp1', d('/a.md'));
    tree = setSplitRatio(tree, 'sp1', 0.99);
    expect(tree.kind === 'split' && tree.ratio).toBe(0.85);
    tree = setSplitRatio(tree, 'sp1', 0.01);
    expect(tree.kind === 'split' && tree.ratio).toBe(0.15);

    tree = replaceSessionInLayout(tree, 's1', 's1-new');
    expect(findLeafByItem(tree, s('s1-new'))?.id).toBe('p1');

    tree = removeSessionFromLayout(tree, 's1-new');
    expect(findLeafByItem(tree, s('s1-new'))).toBeNull();

    tree = removeDocFromLayout(tree, '/a.md');
    expect(findLeafByItem(tree, d('/a.md'))).toBeNull();
  });

  it('builds 1, 2-col, and 2x2 presets', () => {
    let p = 1;
    let sp = 1;
    const nextLeaf = () => `p${p++}`;
    const nextSplit = () => `s${sp++}`;

    const two = applyLayoutPreset('2-col', [s('a'), d('/b.md')], nextLeaf, nextSplit);
    expect(listLeaves(two.layout).map(l => l.item)).toEqual([s('a'), d('/b.md')]);

    const four = applyLayoutPreset('2x2', [s('a'), d('/b.md'), s('c')], nextLeaf, nextSplit);
    expect(listLeaves(four.layout).map(l => l.item)).toEqual([s('a'), d('/b.md'), s('c'), null]);
  });
});
