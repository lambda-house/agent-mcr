export type PaneItem =
  | { kind: 'session'; id: string }
  | { kind: 'custom'; type: string; key: string; payload?: unknown };

export interface PaneLeaf {
  kind: 'leaf';
  id: string;
  item: PaneItem | null;
}

export interface PaneSplit {
  kind: 'split';
  id: string;
  dir: 'row' | 'col';
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export type LayoutPreset = '1' | '2-col' | '2x2';

export function samePaneItem(a: PaneItem | null | undefined, b: PaneItem | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'session' && b.kind === 'session') return a.id === b.id;
  if (a.kind === 'custom' && b.kind === 'custom') return a.type === b.type && a.key === b.key;
  return false;
}

export function createInitialLayout(): PaneLeaf {
  return { kind: 'leaf', id: 'p1', item: null };
}

export function listLeaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === 'leaf') return [node];
  return [...listLeaves(node.a), ...listLeaves(node.b)];
}

export function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.kind === 'leaf') return node.id === id ? node : null;
  return findLeaf(node.a, id) ?? findLeaf(node.b, id);
}

export function findLeafByItem(node: PaneNode, item: PaneItem): PaneLeaf | null {
  if (node.kind === 'leaf') return samePaneItem(node.item, item) ? node : null;
  return findLeafByItem(node.a, item) ?? findLeafByItem(node.b, item);
}

export function splitLeaf(
  node: PaneNode,
  leafId: string,
  dir: 'row' | 'col',
  newLeafId: string,
  splitId: string,
  newItem: PaneItem | null = null,
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.id !== leafId) return node;
    return {
      kind: 'split',
      id: splitId,
      dir,
      ratio: 0.5,
      a: node,
      b: { kind: 'leaf', id: newLeafId, item: newItem },
    };
  }
  const a = splitLeaf(node.a, leafId, dir, newLeafId, splitId, newItem);
  const b = splitLeaf(node.b, leafId, dir, newLeafId, splitId, newItem);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function closeLeaf(node: PaneNode, leafId: string): PaneNode {
  if (node.kind === 'leaf') {
    return node.id === leafId ? { ...node, item: null } : node;
  }
  if (node.a.kind === 'leaf' && node.a.id === leafId) return node.b;
  if (node.b.kind === 'leaf' && node.b.id === leafId) return node.a;
  const a = closeLeaf(node.a, leafId);
  const b = closeLeaf(node.b, leafId);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function setLeafItem(node: PaneNode, leafId: string, item: PaneItem | null): PaneNode {
  if (node.kind === 'leaf') {
    if (node.id !== leafId || samePaneItem(node.item, item)) return node;
    return { ...node, item };
  }
  const a = setLeafItem(node.a, leafId, item);
  const b = setLeafItem(node.b, leafId, item);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function removeSessionFromLayout(node: PaneNode, sessionId: string): PaneNode {
  if (node.kind === 'leaf') {
    return node.item?.kind === 'session' && node.item.id === sessionId ? { ...node, item: null } : node;
  }
  const a = removeSessionFromLayout(node.a, sessionId);
  const b = removeSessionFromLayout(node.b, sessionId);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function replaceSessionInLayout(node: PaneNode, oldId: string, newId: string): PaneNode {
  if (node.kind === 'leaf') {
    return node.item?.kind === 'session' && node.item.id === oldId
      ? { ...node, item: { kind: 'session', id: newId } }
      : node;
  }
  const a = replaceSessionInLayout(node.a, oldId, newId);
  const b = replaceSessionInLayout(node.b, oldId, newId);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function setSplitRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  const clamped = Math.max(0.15, Math.min(0.85, ratio));
  if (node.kind === 'leaf') return node;
  if (node.id === splitId) {
    return node.ratio === clamped ? node : { ...node, ratio: clamped };
  }
  const a = setSplitRatio(node.a, splitId, clamped);
  const b = setSplitRatio(node.b, splitId, clamped);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function applyLayoutPreset(
  preset: LayoutPreset,
  items: PaneItem[],
  nextLeafId: () => string,
  nextSplitId: () => string,
): { layout: PaneNode; focusedPane: string } {
  const p1 = nextLeafId();
  if (preset === '1') {
    return {
      layout: { kind: 'leaf', id: p1, item: items[0] ?? null },
      focusedPane: p1,
    };
  }
  const p2 = nextLeafId();
  if (preset === '2-col') {
    return {
      layout: {
        kind: 'split',
        id: nextSplitId(),
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'leaf', id: p1, item: items[0] ?? null },
        b: { kind: 'leaf', id: p2, item: items[1] ?? null },
      },
      focusedPane: p1,
    };
  }
  const p3 = nextLeafId();
  const p4 = nextLeafId();
  return {
    layout: {
      kind: 'split',
      id: nextSplitId(),
      dir: 'col',
      ratio: 0.5,
      a: {
        kind: 'split',
        id: nextSplitId(),
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'leaf', id: p1, item: items[0] ?? null },
        b: { kind: 'leaf', id: p2, item: items[1] ?? null },
      },
      b: {
        kind: 'split',
        id: nextSplitId(),
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'leaf', id: p3, item: items[2] ?? null },
        b: { kind: 'leaf', id: p4, item: items[3] ?? null },
      },
    },
    focusedPane: p1,
  };
}
