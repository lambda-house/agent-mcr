// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel, ReportsPanel, useBoard } from './BoardView';
import { useSessionsView } from '../sessionsView';
import { formatUntil, harnessApi, openReports, type Board, type Hosted } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(), list: vi.fn(), board: vi.fn(), postNote: vi.fn(), removeNote: vi.fn() } }));
vi.mock('../utils/tauri', () => ({ isTauri: () => true }));
vi.mock('../utils/agent', () => ({ formatAge: () => 'just now' }));

const session: Hosted = { id: 's1', pid: 42, argv: ['claude'], cwd: '/Users/me/repo', started: 1, cols: 120, rows: 32, title: 'Fixing tests', lastOutput: 1, exit: null, meta: { label: 'Claude Code', profile: 'claude' }, harness: { profile: 'claude', state: 'idle', attention: { kind: 'assessment', text: 'Needs you: which database?', since: 3, report: 'needs_human' } } as Hosted['harness'] };
const board: Board = {
  reports: [
    { id: 'r1', session: 's1', name: 'Fixing tests', cwd: '/Users/me/repo', kind: 'done', text: 'Tests pass', created: 1 },
    { id: 'r2', session: 'gone', name: 'Old one', cwd: '/Users/me/repo', kind: 'done', text: 'Merged', created: 2 },
    { id: 'r3', session: 's1', name: 'Fixing tests', cwd: '/Users/me/repo', kind: 'needs_human', text: 'Which database?', created: 3 },
  ],
  notes: [{ id: 'n1', from: { id: 's1', name: 'Fixing tests' }, folder: '/Users/me/repo', scope: 'folder', text: 'Do not run the migration', posted: 1, expires: Date.now() + 5 * 3_600_000, untilItsSessionEnds: true, readBy: 2 }],
};

let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
/** Board as it first is: its two panes; a report opens its session through `onOpen` (Live's). */
const renderBoard = (onOpen: (id: string) => void = () => {}) => {
  useSessionsView.setState({ openLive: onOpen });
  return root.render(<><ReportsPanel/><NotesPanel/></>);
};

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.status).mockResolvedValue({ runner: { protocol: 1, pid: 7, version: '0.1.0', exe: '/x' }, profiles: [], home: '/Users/me' });
  vi.mocked(harnessApi.list).mockResolvedValue([session]);
  vi.mocked(harnessApi.board).mockResolvedValue(board);
  vi.mocked(harnessApi.removeNote).mockResolvedValue();
  // The board read by the last test is gone (the home folder stays: it is asked once)
  useBoard.setState({ board: null, hosted: [], error: '' });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Board view', () => {
  it('lists reports newest first and marks the one still waiting', async () => {
    const onOpen = vi.fn();
    await act(async () => renderBoard(onOpen)); await flush();
    const rows = [...host.querySelectorAll('section[aria-label="Reports"] li')];
    expect(rows.map(li => li.querySelector('.hs-board-text')?.textContent)).toEqual(['Which database?', 'Merged', 'Tests pass']);
    expect(rows.map(li => li.className)).toEqual(['open', '', '']);
    expect(rows[0].textContent).toContain('waiting for you');
    expect(rows[0].textContent).toContain('~/repo');
    // A report of a session that ended is text only
    expect(rows[1].querySelector('button')).toBeNull();
    expect(rows[1].textContent).toContain('session ended');
    await act(async () => (rows[0].querySelector('button') as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith('s1');
  });

  it('filters reports by kind', async () => {
    await act(async () => renderBoard()); await flush();
    const done = [...host.querySelectorAll('.hs-board-filter button')].find(b => b.textContent === 'Done') as HTMLButtonElement;
    await act(async () => done.click());
    expect([...host.querySelectorAll('section[aria-label="Reports"] .hs-board-text')].map(e => e.textContent)).toEqual(['Merged', 'Tests pass']);
  });

  it('groups reports by supervisor, with the status first and the executors under it', async () => {
    const lead: Hosted = { ...session, id: 'lead', title: 'Lead', harness: { ...session.harness!, attention: null } };
    const worker: Hosted = { ...session, id: 'w1', title: 'Worker', harness: { ...session.harness!, attention: null, supervisor: 'lead' } };
    vi.mocked(harnessApi.list).mockResolvedValue([session, lead, worker]);
    vi.mocked(harnessApi.board).mockResolvedValue({ ...board, reports: [
      ...board.reports,
      { id: 'r4', session: 'w1', name: 'Worker', cwd: '/Users/me/repo', kind: 'done', text: 'Parser fixed', created: 4, supervisor: 'lead' },
      { id: 'r5', session: 'lead', name: 'Lead', cwd: '/Users/me/repo', kind: 'done', text: 'Round one reviewed', created: 5 },
      { id: 'r6', session: 'lead', name: 'Lead', cwd: '/Users/me/repo', kind: 'status', text: 'One executor at work', created: 6, executors: [{ session: 'w1', name: 'Worker', state: 'working', needsOperator: false, waits: ['CI run 42'] }, { session: 'w2', name: 'Builder', state: 'waiting', needsOperator: true, waits: [] }] },
    ] });
    const onOpen = vi.fn();
    await act(async () => renderBoard(onOpen)); await flush();
    const groups = [...host.querySelectorAll('.hs-board-group')];
    expect(groups.map(g => g.getAttribute('aria-label'))).toEqual(['Reports of Lead and its executors', 'Reports of sessions without a supervisor']);
    const rows = [...groups[0].querySelectorAll('li')];
    expect(rows.map(li => [li.querySelector('.hs-board-text')?.textContent, li.className, li.style.paddingLeft])).toEqual([
      ['One executor at work', 'status', ''], ['Round one reviewed', '', ''], ['Parser fixed', '', '16px'],
    ]);
    // The status carries its executors as the harness recorded them, and marks nothing
    expect([...rows[0].querySelectorAll('.hs-board-execs [role="listitem"]')].map(e => e.textContent)).toEqual(['Worker working · waited for: CI run 42', 'Builder needed you']);
    expect(rows[0].querySelector('em')).toBeNull();
    expect(groups[1].querySelectorAll('li').length).toBe(3);
    await act(async () => (groups[0].querySelector('.hs-board-group-head button') as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith('lead');
    // The filter for the kind
    const status = [...host.querySelectorAll('.hs-board-filter button')].find(b => b.textContent === 'Status') as HTMLButtonElement;
    await act(async () => status.click());
    expect([...host.querySelectorAll('section[aria-label="Reports"] .hs-board-text')].map(e => e.textContent)).toEqual(['One executor at work']);
  });

  it('posts a note of the person for a folder sessions run in', async () => {
    vi.mocked(harnessApi.postNote).mockResolvedValue();
    await act(async () => renderBoard()); await flush();
    const form = host.querySelector('form[aria-label="Leave a note"]') as HTMLFormElement;
    const post = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    const type = (element: HTMLTextAreaElement | HTMLSelectElement, value: string, event: string) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event(event, { bubbles: true }));
    };
    await act(async () => type(form.querySelector('textarea')!, 'Do not push today', 'input'));
    await act(async () => type(form.querySelector('select[aria-label="Who reads it"]')!, '/Users/me/repo', 'change'));
    await act(async () => post.click()); await flush();
    expect(harnessApi.postNote).toHaveBeenCalledWith('Do not push today', 24, '/Users/me/repo');
    expect(form.querySelector('textarea')!.value).toBe('');
  });

  it('removes a note only on the second click', async () => {
    await act(async () => renderBoard()); await flush();
    const note = host.querySelector('section[aria-label="Bulletin board"] li') as HTMLElement;
    expect(note.textContent).toContain('Do not run the migration');
    expect(note.textContent).toContain('expires in 5 h, or when its session ends');
    expect(note.textContent).toContain('read by 2');
    const remove = () => note.querySelector('.hs-board-remove') as HTMLButtonElement;
    await act(async () => remove().click());
    expect(harnessApi.removeNote).not.toHaveBeenCalled();
    await act(async () => remove().click()); await flush();
    expect(harnessApi.removeNote).toHaveBeenCalledWith('n1');
  });
});

describe('board helpers', () => {
  it('counts a report as open only while its session still carries it', () => {
    const ended = { ...session, exit: { code: 0, signal: null, at: 9 } };
    expect([...openReports(board.reports, [session])]).toEqual(['r3']);
    expect([...openReports(board.reports, [ended])]).toEqual(['r3']);
    expect(openReports(board.reports, [{ ...ended, harness: { ...ended.harness!, attention: null } }]).size).toBe(0);
  });
  it('says how long until a moment', () => {
    expect([30_000, 20 * 60_000, 5 * 3_600_000, 72 * 3_600_000].map(ms => formatUntil(ms, 0))).toEqual(['in 1 min', 'in 20 min', 'in 5 h', 'in 3 days']);
    expect(formatUntil(0, 1000)).toBe('now');
  });
});
