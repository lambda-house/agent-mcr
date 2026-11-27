// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { leaves, type LayoutNode } from '@lambda-house/workbench';
import { defaultLayout, isPanesLayout, LIST_WIDTH, LIST_WIDTH_KEY, useSessionsLayout } from './sessionsLayout';

const types = (root: LayoutNode) => leaves(root).map(l => l.pane?.type);
const KEY = 'agent-mcr-sessions-layout';

beforeEach(() => {
  localStorage.clear();
  for (const view of ['live', 'board', 'slack'] as const) useSessionsLayout.getState().reset(view);
});

describe('Sessions layouts', () => {
  it('starts Live with its list and an empty pane, Board and Slack with their panels', () => {
    expect(types(defaultLayout('live'))).toEqual(['live-sessions', 'empty']);
    expect(types(defaultLayout('board'))).toEqual(['board-reports', 'board-notes']);
    expect(types(defaultLayout('slack'))).toEqual(['slack-waiting', 'slack-posts', 'slack-received', 'slack-connection']);
    for (const view of ['live', 'board', 'slack'] as const) expect(isPanesLayout(defaultLayout(view))).toBe(true);
  });

  it('gives the list the width the person gave it before its layout was kept', () => {
    expect(defaultLayout('live')).toMatchObject({ sizes: [{ px: LIST_WIDTH }, { fr: 1 }] });
    localStorage.setItem(LIST_WIDTH_KEY, '412');
    expect(defaultLayout('live')).toMatchObject({ sizes: [{ px: 412 }, { fr: 1 }] });
    // Narrower than the list can be: the default
    localStorage.setItem(LIST_WIDTH_KEY, '20');
    expect(defaultLayout('live')).toMatchObject({ sizes: [{ px: LIST_WIDTH }, { fr: 1 }] });
  });

  it('takes no layout it could not draw', () => {
    const board = useSessionsLayout.getState().layouts.board;
    const twice: LayoutNode = { kind: 'split', id: 's', dir: 'row', children: [{ kind: 'leaf', id: 'a', pane: { type: 'board-notes', key: 'k' } }, { kind: 'leaf', id: 'b', pane: { type: 'board-reports', key: 'k' } }], sizes: [{ fr: 1 }, { fr: 1 }] };
    useSessionsLayout.getState().setLayout('board', twice);
    expect(useSessionsLayout.getState().layouts.board).toBe(board);
    const swapped: LayoutNode = { ...board, kind: 'split', children: [...(board as Extract<LayoutNode, { kind: 'split' }>).children].reverse() } as LayoutNode;
    useSessionsLayout.getState().setLayout('board', swapped);
    expect(types(useSessionsLayout.getState().layouts.board)).toEqual(['board-notes', 'board-reports']);
  });

  it('keeps each view’s layout and leaf for the next start, and puts back one it could not draw', async () => {
    const live = defaultLayout('live');
    localStorage.setItem(KEY, JSON.stringify({
      version: 1,
      state: {
        layouts: { live: { ...live, sizes: [{ px: 333 }, { fr: 1 }] }, board: { kind: 'leaf', id: 'x', pane: { type: 'board-notes' } }, slack: 'nonsense' },
        focused: { live: 'list', board: 'x', slack: 'x' },
      },
    }));
    await useSessionsLayout.persist.rehydrate();
    const { layouts, focused } = useSessionsLayout.getState();
    expect(layouts.live).toMatchObject({ sizes: [{ px: 333 }, { fr: 1 }] });
    expect(focused.live).toBe('list');
    // A pane without a key, and no layout at all: the defaults
    expect(types(layouts.board)).toEqual(['board-reports', 'board-notes']);
    expect(focused.board).toBe('reports');
    expect(types(layouts.slack)).toEqual(['slack-waiting', 'slack-posts', 'slack-received', 'slack-connection']);
  });
});
