import { findLeaf, findPaneOfType, isPx, leaves, normalize, parentOf, placePane, setPane, type LayoutNode, type Leaf, type PaneRef, type Size } from '@lambda-house/workbench';
import { EMPTY_PANE, LIST_WIDTH, LIVE_LIST, LIVE_LIST_LEAF } from '../sessionsLayout';

// Live's panes on its workbench layout (sessionsLayout.ts): what a pane shows
// (a hosted session, a plugin's pane, or nothing yet: the empty pane), where
// a session opens, and the presets. Pure functions over the layout tree; the
// list and the panels (Board's, Slack's) are panes of the same layout.

export type PaneItem =
  | { kind: 'session'; id: string }
  | { kind: 'custom'; type: string; key: string; payload?: unknown };

export type LayoutPreset = '1' | '2-col' | '2x2';

/** A hosted session's pane, kept alive while it moves (its terminal). */
export const SESSION_PANE = 'session';
/** A plugin's pane (`registerPaneType`). */
export const CUSTOM_PANE = 'custom';

export function samePaneItem(a: PaneItem | null | undefined, b: PaneItem | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'session' && b.kind === 'session') return a.id === b.id;
  if (a.kind === 'custom' && b.kind === 'custom') return a.type === b.type && a.key === b.key;
  return false;
}

let counter = 0;
/** An id for a new leaf, split or empty pane. */
export const newPaneId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(++counter).toString(36)}`;

/** The pane that shows an item; with none, an empty pane. */
export function paneOf(item: PaneItem | null): PaneRef {
  if (!item) return { type: EMPTY_PANE, key: newPaneId(EMPTY_PANE) };
  return item.kind === 'session'
    ? { type: SESSION_PANE, key: `session:${item.id}`, state: item }
    : { type: CUSTOM_PANE, key: `custom:${item.type}:${item.key}`, state: item };
}

/** What a pane shows: a session or a plugin's pane; null for an empty pane, the list or a panel. */
export function itemOf(pane: PaneRef | null | undefined): PaneItem | null {
  return pane && (pane.type === SESSION_PANE || pane.type === CUSTOM_PANE) ? (pane.state as PaneItem | undefined) ?? null : null;
}

/** A leaf a session can open in: a session's, a plugin's or an empty pane (not the list, not a panel). */
export function isSlot(leaf: Leaf): boolean {
  const type = leaf.pane?.type;
  return !type || type === SESSION_PANE || type === CUSTOM_PANE || type === EMPTY_PANE;
}

export const slotsOf = (root: LayoutNode): Leaf[] => leaves(root).filter(isSlot);

export function findLeafByItem(root: LayoutNode, item: PaneItem): Leaf | undefined {
  return leaves(root).find(leaf => samePaneItem(itemOf(leaf.pane), item));
}

/** Show an item in a leaf, or empty it (null). */
export function setLeafItem(root: LayoutNode, leafId: string, item: PaneItem | null): LayoutNode {
  const leaf = findLeaf(root, leafId);
  if (!leaf) return root;
  if (item ? samePaneItem(itemOf(leaf.pane), item) : leaf.pane?.type === EMPTY_PANE) return root;
  return setPane(root, leafId, paneOf(item));
}

/** Every pane showing an item that matches is emptied. */
export function clearItems(root: LayoutNode, predicate: (item: PaneItem) => boolean): LayoutNode {
  return leaves(root).reduce((tree, leaf) => {
    const item = itemOf(leaf.pane);
    return item && predicate(item) ? setPane(tree, leaf.id, paneOf(null)) : tree;
  }, root);
}

export const removeSessionFromLayout = (root: LayoutNode, sessionId: string): LayoutNode =>
  clearItems(root, item => item.kind === 'session' && item.id === sessionId);

/** A restarted session (a new id) takes its old pane. */
export function replaceSessionInLayout(root: LayoutNode, oldId: string, newId: string): LayoutNode {
  const leaf = findLeafByItem(root, { kind: 'session', id: oldId });
  return leaf ? setPane(root, leaf.id, paneOf({ kind: 'session', id: newId })) : root;
}

/** Where no pane can take a session (all are panels): a new one beside the list, or beside the first pane. */
export function addSlot(root: LayoutNode, leafId: string, item: PaneItem | null): LayoutNode {
  const beside = findPaneOfType(root, LIVE_LIST) ?? leaves(root)[0];
  return placePane(root, beside.id, 'after', { kind: 'leaf', id: leafId, pane: paneOf(item) }, { fr: 1 });
}

/** The list's width where it is: its pixels in a row, else the default. */
function listSize(root: LayoutNode, list: Leaf): Size {
  const place = parentOf(root, list.id);
  const size = place?.split.dir === 'row' ? place.split.sizes[place.index] : undefined;
  return size && isPx(size) ? size : { px: LIST_WIDTH };
}

/**
 * A preset: the list (as it was, or back at its width) beside one pane, two
 * columns or a 2×2 grid, filled with `items` in order. Panels in Live go.
 */
export function presetLayout(root: LayoutNode, preset: LayoutPreset, items: PaneItem[]): { root: LayoutNode; focused: string } {
  const count = preset === '1' ? 1 : preset === '2-col' ? 2 : 4;
  const panes: Leaf[] = Array.from({ length: count }, (_, i) => ({ kind: 'leaf', id: newPaneId('p'), pane: paneOf(items[i] ?? null) }));
  const row = (children: Leaf[]): LayoutNode => ({ kind: 'split', id: newPaneId('s'), dir: 'row', children, sizes: children.map(() => ({ fr: 1 })) });
  const grid: LayoutNode = preset === '1' ? panes[0]
    : preset === '2-col' ? row(panes)
    : { kind: 'split', id: newPaneId('s'), dir: 'col', children: [row(panes.slice(0, 2)), row(panes.slice(2))], sizes: [{ fr: 1 }, { fr: 1 }] };
  const old = findPaneOfType(root, LIVE_LIST);
  const list: Leaf = old ?? { kind: 'leaf', id: LIVE_LIST_LEAF, pane: { type: LIVE_LIST, key: LIVE_LIST } };
  const size = old ? listSize(root, old) : { px: LIST_WIDTH };
  return { root: normalize({ kind: 'split', id: 'live', dir: 'row', children: [list, grid], sizes: [size, { fr: 1 }] }), focused: panes[0].id };
}
