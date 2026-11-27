import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { leaves, normalize, type LayoutNode } from '@lambda-house/workbench';

// The layouts of Sessions' views that hold panes (shared UI spec §5.3): Live
// (its session list, the sessions' panes, any panel), Board and Slack (their
// panels, which every one of the three can show). Kept per viewer, with the
// leaf each view acts on. A saved layout that is not a tree of leaves with
// their own ids and keys is replaced by its view's default.

export type PanesView = 'live' | 'board' | 'slack';
export const PANES_VIEWS: readonly PanesView[] = ['live', 'board', 'slack'];

/** The pane type that asks what to show (`placeholder`): what a split adds. */
export const EMPTY_PANE = 'empty';
/** Live's session list. */
export const LIVE_LIST = 'live-sessions';
export const LIVE_LIST_LEAF = 'list';
/** The pane a session opens in at first. */
export const LIVE_FIRST_LEAF = 'p1';
/** The session list's width at first, px; it was `hs-list-width` before Live's layout was kept. */
export const LIST_WIDTH = 290;
export const LIST_WIDTH_KEY = 'hs-list-width';
/** The session list is never narrower than this. */
export const LIST_MIN_WIDTH = 200;

/** The width the person gave the list before Live's layout was kept. */
function savedListWidth(): number {
  try { const v = Number(localStorage.getItem(LIST_WIDTH_KEY)); return v >= LIST_MIN_WIDTH ? Math.round(v) : LIST_WIDTH; } catch { return LIST_WIDTH; }
}

const leaf = (id: string, type: string) => ({ kind: 'leaf' as const, id, pane: { type, key: type === EMPTY_PANE ? `${EMPTY_PANE}-${id}` : type } });

/** Each view as it first is. */
export function defaultLayout(view: PanesView): LayoutNode {
  if (view === 'live') {
    return { kind: 'split', id: 'live', dir: 'row', children: [leaf(LIVE_LIST_LEAF, LIVE_LIST), leaf(LIVE_FIRST_LEAF, EMPTY_PANE)], sizes: [{ px: savedListWidth() }, { fr: 1 }] };
  }
  if (view === 'board') {
    return { kind: 'split', id: 'board', dir: 'row', children: [leaf('reports', 'board-reports'), leaf('notes', 'board-notes')], sizes: [{ fr: 3 }, { fr: 2 }] };
  }
  return {
    kind: 'split', id: 'slack', dir: 'row',
    children: [
      { kind: 'split', id: 'slack-posts', dir: 'col', children: [leaf('waiting', 'slack-waiting'), leaf('posts', 'slack-posts'), leaf('received', 'slack-received')], sizes: [{ fr: 1 }, { fr: 1 }, { fr: 1 }] },
      leaf('connection', 'slack-connection'),
    ],
    sizes: [{ fr: 3 }, { fr: 2 }],
  };
}

/** A layout that can be drawn: leaves with their own ids, panes with a type and their own keys. */
export function isPanesLayout(value: unknown): value is LayoutNode {
  try {
    const all = leaves(normalize(value as LayoutNode));
    const ids = all.map(l => l.id);
    const panes = all.flatMap(l => l.pane ? [l.pane] : []);
    const keys = panes.map(p => p.key);
    return all.length > 0
      && ids.every(id => typeof id === 'string' && id !== '') && new Set(ids).size === ids.length
      && panes.every(p => typeof p.type === 'string' && typeof p.key === 'string') && new Set(keys).size === keys.length;
  } catch {
    return false;
  }
}

interface SessionsLayouts {
  layouts: Record<PanesView, LayoutNode>;
  /** The leaf each view acts on (Live: the one a session opens in). */
  focused: Record<PanesView, string>;
  setLayout: (view: PanesView, root: LayoutNode) => void;
  focus: (view: PanesView, leaf: string) => void;
  reset: (view: PanesView) => void;
}

const defaults = () => ({
  layouts: { live: defaultLayout('live'), board: defaultLayout('board'), slack: defaultLayout('slack') },
  focused: { live: LIVE_FIRST_LEAF, board: 'reports', slack: 'waiting' },
});

export const useSessionsLayout = create<SessionsLayouts>()(persist((set) => ({
  ...defaults(),
  setLayout: (view, root) => set(s => s.layouts[view] === root || !isPanesLayout(root) ? s : { layouts: { ...s.layouts, [view]: root } }),
  focus: (view, leafId) => set(s => s.focused[view] === leafId ? s : { focused: { ...s.focused, [view]: leafId } }),
  reset: (view) => set(s => ({ layouts: { ...s.layouts, [view]: defaultLayout(view) }, focused: { ...s.focused, [view]: defaults().focused[view] } })),
}), {
  name: 'agent-mcr-sessions-layout',
  version: 1,
  partialize: s => ({ layouts: s.layouts, focused: s.focused }),
  // What was saved, view by view; a layout that can't be drawn is its default
  merge: (saved, current) => {
    const kept = (saved ?? {}) as Partial<Pick<SessionsLayouts, 'layouts' | 'focused'>>;
    const layouts = { ...current.layouts };
    const focused = { ...current.focused };
    for (const view of PANES_VIEWS) {
      const layout = kept.layouts?.[view];
      if (isPanesLayout(layout)) {
        layouts[view] = layout;
        const leafId = kept.focused?.[view];
        if (typeof leafId === 'string') focused[view] = leafId;
      }
    }
    return { ...current, layouts, focused };
  },
}));
