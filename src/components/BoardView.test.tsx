// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BoardView from './BoardView';
import { formatUntil, harnessApi, openReports, type Board, type Hosted } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(), list: vi.fn(), board: vi.fn(), removeNote: vi.fn() } }));
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

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.status).mockResolvedValue({ runner: { protocol: 1, pid: 7, version: '0.1.0', exe: '/x' }, profiles: [], home: '/Users/me' });
  vi.mocked(harnessApi.list).mockResolvedValue([session]);
  vi.mocked(harnessApi.board).mockResolvedValue(board);
  vi.mocked(harnessApi.removeNote).mockResolvedValue();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Board view', () => {
  it('lists reports newest first and marks the one still waiting', async () => {
    const onOpen = vi.fn();
    await act(async () => root.render(<BoardView active onOpen={onOpen}/>)); await flush();
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
    await act(async () => root.render(<BoardView active onOpen={() => {}}/>)); await flush();
    const done = [...host.querySelectorAll('.hs-board-filter button')].find(b => b.textContent === 'Done') as HTMLButtonElement;
    await act(async () => done.click());
    expect([...host.querySelectorAll('section[aria-label="Reports"] .hs-board-text')].map(e => e.textContent)).toEqual(['Merged', 'Tests pass']);
  });

  it('removes a note only on the second click', async () => {
    await act(async () => root.render(<BoardView active onOpen={() => {}}/>)); await flush();
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
    expect([...openReports(board.reports, [session])]).toEqual(['r3']);
    expect(openReports(board.reports, [{ ...session, harness: { ...session.harness!, attention: null } }]).size).toBe(0);
    expect(openReports(board.reports, [{ ...session, exit: { code: 0, signal: null, at: 9 } }]).size).toBe(0);
  });
  it('says how long until a moment', () => {
    expect([30_000, 20 * 60_000, 5 * 3_600_000, 72 * 3_600_000].map(ms => formatUntil(ms, 0))).toEqual(['in 1 min', 'in 20 min', 'in 5 h', 'in 3 days']);
    expect(formatUntil(0, 1000)).toBe('now');
  });
});
