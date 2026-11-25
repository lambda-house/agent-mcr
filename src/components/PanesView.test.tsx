// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leaves } from '@lambda-house/workbench';
import PanesView, { emptyPane } from './PanesView';
import { boardPanes } from './BoardView';
import { slackPanes } from './SlackView';
import { pluginRegistry } from '../plugins';
import { useSessionsLayout } from '../sessionsLayout';
import { harnessApi, slackApi } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(), list: vi.fn(), board: vi.fn() }, slackApi: { status: vi.fn() } }));
vi.mock('../utils/tauri', () => ({ isTauri: () => true }));
vi.mock('../utils/agent', () => ({ formatAge: () => 'just now' }));

// The panels and the empty pane in Board's layout, as App's documentsPlugin contributes them
pluginRegistry.workbench.register({ id: 'panes-test', name: 'Panes', required: true, setup: api => { for (const type of [...boardPanes, ...slackPanes, emptyPane]) api.contribute('workbench:pane-type', { view: 'board', type }); } });

let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const types = () => leaves(useSessionsLayout.getState().layouts.board).map(l => l.pane?.type);
const leafOf = (type: string) => leaves(useSessionsLayout.getState().layouts.board).find(l => l.pane?.type === type)!.id;
const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const choose = async (label: string) => { await act(async () => items().find(b => b.textContent === label)!.click()); await flush(); };
const paneMenu = (type: string) => host.querySelector<HTMLButtonElement>(`[data-leaf="${leafOf(type)}"] button[aria-label$="pane menu"]`)!;

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useSessionsLayout.getState().reset('board');
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.status).mockResolvedValue({ runner: { protocol: 1, pid: 7, version: '0.1.0', exe: '/x' }, profiles: [], home: '/Users/me' });
  vi.mocked(harnessApi.list).mockResolvedValue([]);
  vi.mocked(harnessApi.board).mockResolvedValue({ reports: [], notes: [] });
  vi.mocked(slackApi.status).mockResolvedValue(null as never);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('Board and Slack as panes', () => {
  it('splits a panel into an empty pane, which shows the panel chosen in it', async () => {
    await act(async () => root.render(<PanesView view="board"/>)); await flush();
    expect(types()).toEqual(['board-reports', 'board-notes']);
    await act(async () => paneMenu('board-reports').click());
    await choose('Split Down');
    expect(types()).toEqual(['board-reports', 'empty', 'board-notes']);
    // It offers the panels not shown here, Slack's too
    const choices = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Show a panel here"] button')];
    expect(choices.map(b => b.querySelector('strong')?.textContent)).toEqual(['Waiting for you', 'Posts', 'Received', 'Connection']);
    await act(async () => choices[1].click()); await flush();
    expect(types()).toEqual(['board-reports', 'slack-posts', 'board-notes']);
    expect(host.querySelector('section[aria-label="Posts"]')).not.toBeNull();
    expect(slackApi.status).toHaveBeenCalled();
  });

  it('turns a panel into another from its title, and joins and swaps panels', async () => {
    await act(async () => root.render(<PanesView view="board"/>)); await flush();
    await act(async () => host.querySelector<HTMLButtonElement>(`[data-leaf="${leafOf('board-notes')}"] .wb-pane-type`)!.click());
    expect(items().map(b => b.textContent)).toEqual(['Waiting for you', 'Posts', 'Received', 'Connection']);
    await choose('Waiting for you');
    expect(types()).toEqual(['board-reports', 'slack-waiting']);
    await act(async () => paneMenu('board-reports').click());
    await choose('Swap with Waiting for you');
    expect(types()).toEqual(['slack-waiting', 'board-reports']);
    await act(async () => paneMenu('board-reports').click());
    await choose('Join with Waiting for you');
    expect(types()).toEqual(['board-reports']);
  });
});
