// @vitest-environment happy-dom
import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChangesPane from './ChangesPane';
import { changesApi, HIDDEN, type Changes } from '../utils/changes';
import type { Hosted } from '../utils/harness';

vi.mock('../utils/changes', async importOriginal => ({ ...await importOriginal<object>(), changesApi: { read: vi.fn() } }));

const hosted = (id = 'h1'): Hosted => ({ id, pid: 1, argv: [], cwd: '/work/repo/sub', started: 1, cols: 80, rows: 24, title: '', exit: null, meta: { profile: 'codex' } });
const changes = (): Changes => ({
  note: null,
  repo: {
    root: '/work/repo', branch: 'mcr-1-thing', head: '0123456789abcdef0123456789abcdef01234567',
    base: { name: 'origin/main', ahead: 2, behind: 1, mergeBase: 'f'.repeat(40) }, baseNote: null,
    upstream: { name: 'origin/mcr-1-thing', ahead: 1, behind: 0, mergeBase: null },
    commits: [{ sha: 'b'.repeat(40), short: 'bbbbbbb', subject: 'Second', author: 'T', time: 1 }, { sha: 'c'.repeat(40), short: 'ccccccc', subject: 'First', author: 'T', time: 1 }],
    commitsMore: false,
    committed: { files: [{ path: 'src/lib.rs', status: 'M', staged: false, unstaged: false, added: 3, removed: 1, binary: false, diff: 'diff --git a/src/lib.rs b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n', diffNote: null, hidden: 0, undone: false }], more: false, note: null },
    uncommitted: { files: [
      { path: 'big.json', status: 'M', staged: false, unstaged: true, added: 9000, removed: 0, binary: false, diff: null, diffNote: 'too large to show here: run git diff in a terminal', hidden: 0, undone: false },
      { path: '.env', status: 'A', staged: true, unstaged: false, added: 2, removed: 0, binary: false, diff: `diff --git a/.env b/.env\n@@ -0,0 +1,2 @@\n+NAME=demo\n+${HIDDEN}\n`, diffNote: null, hidden: 1, undone: false },
    ], more: false, note: null },
    untracked: ['notes/'], untrackedMore: false, hidden: 1,
  },
});

let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('Changes pane', () => {
  it('shows the branch, head, base and upstream, the commits ahead, the files and a diff', async () => {
    vi.mocked(changesApi.read).mockResolvedValue(changes());
    await act(async () => root.render(<ChangesPane session={hosted()} active/>)); await flush();
    // The page names the session, never a folder
    expect(changesApi.read).toHaveBeenCalledWith('h1');
    const text = host.textContent ?? '';
    expect(host.querySelector('.hs-changes-head strong')?.textContent).toBe('mcr-1-thing');
    expect(host.querySelector('.hs-changes-sha')?.textContent).toBe('0123456789ab');
    expect(host.querySelector('.hs-changes-sha')?.getAttribute('title')).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(text).toContain('Base origin/main: 2 ahead, 1 behind');
    expect(text).toContain('Upstream origin/mcr-1-thing: 1 ahead');
    expect([...host.querySelectorAll('.hs-changes-commits li')].map(li => li.textContent)).toEqual(['bbbbbbbSecond', 'cccccccFirst']);
    expect(text).toContain('Uncommitted · 2 · +9002 −0');
    expect(text).toContain('Committed since origin/main · 1 · +3 −1');
    expect(text).toContain('Untracked: notes/');
    // The first file with a diff is shown: big.json has none
    expect(host.querySelector('.hs-changes-diff h4')?.textContent).toBe('.env · +2 −0 · staged');
    expect([...host.querySelectorAll('.hs-diff span')].map(s => s.className)).toEqual(['hs-diff-meta', 'hs-diff-hunk', 'hs-diff-add', 'hs-diff-hidden']);
    expect(text).toContain('One line is hidden: they have the shape of a credential');
    // Read only: the only buttons are Refresh and the files
    const buttons = [...host.querySelectorAll('button')].map(b => b.getAttribute('aria-label') ?? b.querySelector('.hs-stats-name')?.textContent);
    expect(buttons).toEqual(['Refresh changes', 'big.json', '.env', 'src/lib.rs']);
    await act(async () => (host.querySelectorAll('.hs-changes-files button')[0] as HTMLButtonElement).click());
    expect(host.querySelector('.hs-changes-diff')?.textContent).toContain('too large to show here');
    await act(async () => (host.querySelectorAll('.hs-changes-files button')[2] as HTMLButtonElement).click());
    expect(host.querySelector('.hs-diff')?.textContent).toBe('diff --git a/src/lib.rs b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n');
  });

  it('reads when shown, on focus and on Refresh, and never on a timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] });
    vi.mocked(changesApi.read).mockResolvedValue(changes());
    await act(async () => root.render(<ChangesPane session={hosted()} active/>));
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(changesApi.read).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(changesApi.read).toHaveBeenCalledTimes(2);
    await act(async () => (host.querySelector('.hs-changes-refresh') as HTMLButtonElement).click());
    expect(changesApi.read).toHaveBeenCalledTimes(3);
    // Another session in the pane is read for that session
    await act(async () => root.render(<ChangesPane session={hosted('h2')} active/>));
    expect(changesApi.read).toHaveBeenLastCalledWith('h2');
  });

  it('reads nothing while the Live view is not shown', async () => {
    vi.mocked(changesApi.read).mockResolvedValue(changes());
    await act(async () => root.render(<ChangesPane session={hosted()} active={false}/>)); await flush();
    await act(async () => { window.dispatchEvent(new Event('focus')); }); await flush();
    expect(changesApi.read).not.toHaveBeenCalled();
  });

  it('renders nothing again when a read on focus says the same', async () => {
    vi.mocked(changesApi.read).mockImplementation(async () => changes());
    const commits = vi.fn();
    await act(async () => root.render(<Profiler id="changes" onRender={commits}><ChangesPane session={hosted()} active/></Profiler>)); await flush();
    const after = commits.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); }); await flush();
    expect(changesApi.read).toHaveBeenCalledTimes(2);
    expect(commits.mock.calls.length).toBe(after);
    // A changed answer does render
    vi.mocked(changesApi.read).mockImplementation(async () => ({ ...changes(), repo: { ...changes().repo!, branch: 'other' } }));
    await act(async () => { window.dispatchEvent(new Event('focus')); }); await flush();
    expect(commits.mock.calls.length).toBeGreaterThan(after);
    expect(host.querySelector('.hs-changes-head strong')?.textContent).toBe('other');
  });

  it('says why when there is nothing to show', async () => {
    vi.mocked(changesApi.read).mockResolvedValue({ repo: null, note: 'This folder is not in a git work tree.' });
    await act(async () => root.render(<ChangesPane session={hosted()} active/>)); await flush();
    expect(host.textContent).toContain('This folder is not in a git work tree.');
    await act(async () => root.unmount()); root = createRoot(host);
    vi.mocked(changesApi.read).mockRejectedValue(new Error('No such session'));
    await act(async () => root.render(<ChangesPane session={hosted()} active/>)); await flush();
    expect(host.querySelector('.hs-changes-error')?.textContent).toBe('No such session');
  });

  it('says a list was cut even when no row of it is left (review 17426)', async () => {
    const c = changes();
    const repo = { ...c.repo!, commits: [], commitsMore: true, uncommitted: { files: [], more: true, note: null }, untracked: [], untrackedMore: true };
    vi.mocked(changesApi.read).mockResolvedValue({ ...c, repo });
    await act(async () => root.render(<ChangesPane session={hosted()} active/>)); await flush();
    const text = host.textContent ?? '';
    expect(text).not.toContain('Nothing.');
    expect(text).not.toContain('None.');
    expect(text).toContain('Too many to list here.');
    expect(text).toContain('More files than can be listed here.');
    expect(text).toContain('Untracked: more names than can be listed here.');
    // Untracked names alone, cut: still not "Nothing"
    vi.mocked(changesApi.read).mockResolvedValue({ ...c, repo: { ...repo, uncommitted: { files: [], more: false, note: null } } });
    await act(async () => { window.dispatchEvent(new Event('focus')); }); await flush();
    expect(host.textContent).not.toContain('Nothing.');
    expect(host.textContent).toContain('Untracked: more names than can be listed here.');
  });

  it('lets Refresh be pressed again after a read on focus took over its read (review 17426)', async () => {
    const pending: ((c: Changes) => void)[] = [];
    vi.mocked(changesApi.read).mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
    await act(async () => root.render(<ChangesPane session={hosted()} active/>));
    await act(async () => pending.shift()!(changes())); await flush();
    const refresh = () => host.querySelector('.hs-changes-refresh') as HTMLButtonElement;
    await act(async () => refresh().click());
    expect(refresh().disabled).toBe(true);
    // The window comes back to the front while the pressed read is under way
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(pending).toHaveLength(2);
    await act(async () => pending.shift()!(changes())); await flush();
    expect(refresh().disabled).toBe(true);
    await act(async () => pending.shift()!(changes())); await flush();
    expect(refresh().disabled).toBe(false);
  });

  it('says a staged change may be undone in the work tree, and never that the two agree (review 17503)', async () => {
    const c = changes();
    const undone = { ...c.repo!.uncommitted.files[1], path: 'a.txt', status: 'M', staged: true, unstaged: true, undone: true, hidden: 0, diff: 'diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n one\n+staged\ndiff --git a/a.txt b/a.txt\n@@ -1,2 +1 @@\n one\n-staged\n' };
    vi.mocked(changesApi.read).mockResolvedValue({ ...c, repo: { ...c.repo!, hidden: 0, uncommitted: { files: [undone], more: false, note: null } } });
    await act(async () => root.render(<ChangesPane session={hosted()} active/>)); await flush();
    expect(host.querySelector('.hs-changes-diff h4')?.textContent).toBe('a.txt · +2 −0 · staged, changed since');
    const shown = host.querySelector('.hs-changes-diff')?.textContent ?? '';
    expect(shown).toContain('the work tree may put the staged change back');
    expect(shown).toContain('A commit would still take the staged change');
    expect(shown).not.toMatch(/agree|undone in the work tree/);
  });
});
