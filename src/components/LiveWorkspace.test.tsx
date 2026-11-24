// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveWorkspace from './LiveWorkspace';
import { HARNESS_PREFERENCES_CHANGED, harnessApi, type Hosted } from '../utils/harness';
import { pickDirectory } from '../utils/tauri';
import { useStore } from '../store';
import { DEFAULT_LIVE_LIST } from '../utils/harness';
import { liveNav } from '../utils/liveNav';
import { hostedDetail } from './SessionRow';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(), list: vi.fn(), listSince: vi.fn(), spawn: vi.fn(), signal: vi.fn(), forget: vi.fn(), restart: vi.fn(), resumable: vi.fn(), storeNoticeSeen: vi.fn(), ack: vi.fn(), supervisor: vi.fn(), background: vi.fn(), allowBackground: vi.fn(), stopBackground: vi.fn() } }));
vi.mock('./SessionRow', async importOriginal => {
  const original = await importOriginal<typeof import('./SessionRow')>();
  return { ...original, hostedDetail: vi.fn(original.hostedDetail) };
});
vi.mock('../utils/tauri', () => ({ isTauri: () => true, pickDirectory: vi.fn() }));
// Terminals need a real canvas; the pane itself is exercised in the app
// The link button stands for a click on `mcr:<linkTo>` in that terminal's text
// and the stand-in takes the keyboard as the pane does: once per request, then says so. `mounts` counts its mounts.
let linkTo = '';
// Every isSession a terminal was given: it stays the same function while the same sessions run (MCR-106)
const givenIsSession: unknown[] = [];
const focused: string[] = [];
const mounts: string[] = [];
const unmounts: string[] = [];
// Every render of a terminal stand-in: a list poll that changed nothing renders none (MCR-139)
const renders: string[] = [];
// The keep of hidden terminals (MCR-139): what the view tells it to retain
const kept = vi.hoisted(() => ({ retained: [] as string[][], retain(ids: Set<string>) { this.retained.push([...ids].sort()); }, protect: vi.fn() }));
vi.mock('./TerminalPane', async () => {
  const { useEffect } = await import('react');
  return { keep: kept, default: ({ id, onQuit, isSession, onSession, focusAt, onFocused }: { id: string; onQuit?: () => void; isSession?: (id: string) => boolean; onSession?: (id: string) => void; focusAt?: number; onFocused?: () => void }) => {
    renders.push(id);
    useEffect(() => { mounts.push(id); return () => { unmounts.push(id); }; }, [id]);
    useEffect(() => { givenIsSession.push(isSession); }, [isSession]);
    useEffect(() => { if (focusAt) { focused.push(id); onFocused?.(); } }, [focusAt]); // eslint-disable-line react-hooks/exhaustive-deps
    return <div data-terminal={id} data-focus-at={focusAt ?? ''} data-links={['r1', 'e1', 's1', 'nobody'].filter(x => isSession?.(x)).join(' ')}><button aria-label={`quit ${id}`} onClick={onQuit}/><button aria-label={`link in ${id}`} onClick={() => onSession?.(linkTo)}/></div>;
  } };
});

const running: Hosted = { id: 'r1', pid: 42, argv: ['/bin/zsh', '-l', '-i', '-c', 'exec claude'], cwd: '/work/repo', started: 2, cols: 120, rows: 32, title: 'Fixing tests', lastOutput: 1, exit: null, meta: { label: 'Claude Code', profile: 'claude' } };
const ended: Hosted = { ...running, id: 'e1', started: 1, title: '', exit: { code: 0, signal: null, at: 3 }, meta: { label: 'Shell', profile: 'shell' } };
const withReport = (h: Hosted, report: 'done' | 'needs_human', text: string, since = 5): Hosted => ({
  ...h, harness: { name: '', profile: 'claude', state: h.exit ? 'exited' : 'idle', since: 1, precise: true, agentSession: null, lastMessage: null,
    attention: { report, kind: report === 'done' ? 'notification' : 'assessment', text, since } },
});

let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
let slotHeight: number;
let intersectionHeight: number;
const intersections = new Map<Element, () => void>();
const resizes = new Set<() => void>();

beforeEach(() => {
  vi.resetAllMocks();
  slotHeight = intersectionHeight = 400;
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: (entries: Partial<ResizeObserverEntry>[]) => void) {}
    private notify = () => this.callback([{ contentRect: new DOMRect(0, 0, 600, slotHeight) }]);
    observe() { resizes.add(this.notify); this.notify(); }
    disconnect() { resizes.delete(this.notify); }
  });
  vi.stubGlobal('IntersectionObserver', class {
    private target?: Element;
    constructor(private callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
    observe(target: Element) {
      this.target = target;
      const notify = () => this.callback([{ isIntersecting: true, intersectionRect: new DOMRect(0, 0, 600, Math.min(slotHeight, intersectionHeight)) }]);
      intersections.set(target, notify);
      notify();
    }
    unobserve(target: Element) { intersections.delete(target); }
    disconnect() { if (this.target) this.unobserve(this.target); }
    takeRecords() { return []; }
  });
  localStorage.removeItem('hs-dirs');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.status).mockResolvedValue({ runner: { protocol: 1, pid: 7, version: '0.1.0', exe: '/x' }, profiles: [{ id: 'claude', label: 'Claude Code', command: 'claude', optional: false, canSupervise: true, taskTracking: true }, { id: 'codex', label: 'Codex', command: 'codex', optional: false, canSupervise: true, taskTracking: true }, { id: 'antigravity', label: 'Antigravity', command: 'agy --mode accept-edits', optional: true, canSupervise: true, taskTracking: false }, { id: 'pi', label: 'Pi', command: 'pi', optional: true, canSupervise: true, taskTracking: false }, { id: 'opencode', label: 'OpenCode', command: 'opencode', optional: true, canSupervise: true, taskTracking: false }, { id: 'shell', label: 'Terminal', command: '', optional: false, canSupervise: false, taskTracking: false }], supervisorProfile: 'claude', home: '/Users/me' });
  vi.mocked(harnessApi.list).mockResolvedValue([ended, running]);
  vi.mocked(harnessApi.listSince).mockImplementation(async held => {
    const sessions = (await harnessApi.list()).map(({ lastOutput: _, ...row }) => row);
    const stamp = JSON.stringify(sessions);
    return { stamp, sessions: stamp === held ? null : sessions };
  });
  vi.mocked(harnessApi.resumable).mockResolvedValue([]);
  vi.mocked(harnessApi.ack).mockResolvedValue();
  // The list's choices live in the app's settings, shared by every test here
  useStore.setState({ liveList: DEFAULT_LIVE_LIST });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const rows = () => [...host.querySelectorAll('.hs-dir > ul > li')];
const folders = () => [...host.querySelectorAll('.hs-dir')];

it('only renders the previous and next session rows when selection changes', async () => {
  const third = { ...running, id: 'r3', title: 'Third session' };
  vi.mocked(harnessApi.list).mockResolvedValue([ended, running, third]);
  await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>));
  const rowButton = (title: string) => rows().find(r => r.textContent?.includes(title))!.querySelector('button')!;
  await act(async () => rowButton('Fixing tests').click());
  vi.mocked(hostedDetail).mockClear();
  await act(async () => rowButton('Third session').click());
  expect(vi.mocked(hostedDetail).mock.calls.map(([session]) => session.id).sort()).toEqual(['r1', 'r3']);
  expect(host.querySelector('.hs-dir li.selected')?.textContent).toContain('Third session');
});

it('advances hosted row and Supervisor ages while the list stamp stays the same', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  try {
    const now = Date.now();
    const working: Hosted = { ...running, harness: {
      name: 'Fixing tests', profile: 'claude', state: 'working', since: now - 150_000,
      precise: true, agentSession: null, lastMessage: null, attention: null, status: 'running tests',
    } };
    const supervisor: Hosted = { ...working, id: 'supervisor', meta: { ...working.meta, role: 'supervisor' } };
    const done: Hosted = { ...working, id: 'done', harness: { ...working.harness!, state: 'idle', lastMessage: 'Fixed', lastMessageAt: now - 270_000 } };
    const justEnded = withReport({ ...ended, exit: { ...ended.exit!, at: now - 1000 } }, 'done', 'Run finished');
    vi.mocked(harnessApi.list).mockResolvedValue([working, supervisor, done, justEnded]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>));
    const rowLabels = () => rows().map(row => row.textContent).join('\n');
    const supervisorAge = () => host.querySelector('.hs-supervisor .hs-lead')?.textContent;
    expect(rowLabels()).toContain('Working 2m');
    expect(rowLabels()).toContain('Done 4m ago');
    expect(rowLabels()).toContain('exited with 0 · just now');
    expect(supervisorAge()).toBe('Working 2m');
    vi.mocked(hostedDetail).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(hostedDetail).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(28_000); });
    expect(rowLabels()).toContain('Working 3m');
    expect(rowLabels()).toContain('Done 5m ago');
    expect(rowLabels()).toContain('exited with 0 · 1 min ago');
    expect(supervisorAge()).toBe('Working 3m');
  } finally { vi.useRealTimers(); }
});

it('detaches a clipped slot in a visible window and keeps it attached when the window hides', async () => {
  slotHeight = 0;
  await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>));
  await act(async () => rows().find(row => row.textContent?.includes('Fixing tests'))?.querySelector('button')?.click());
  const terminal = () => host.querySelector('[data-terminal="r1"]');
  expect(terminal()).toBeNull();

  const resize = async (height: number) => {
    slotHeight = height;
    await act(async () => resizes.forEach(notify => notify()));
  };
  const intersect = async (height: number) => {
    intersectionHeight = height;
    await act(async () => intersections.forEach(notify => notify()));
  };
  intersectionHeight = 0;
  await resize(400);
  expect(terminal()).toBeNull();
  await intersect(400);
  expect(terminal()).not.toBeNull();
  expect(kept.protect).toHaveBeenLastCalledWith(new Set(['r1']));
  await resize(0);
  expect(terminal()).toBeNull();
  expect(unmounts[unmounts.length - 1]).toBe('r1');
  await resize(400);
  expect(terminal()).not.toBeNull();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await resize(0);
  await intersect(0);
  expect(terminal()).not.toBeNull();
  hidden.mockReturnValue(false);
  slotHeight = intersectionHeight = 400;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(terminal()).not.toBeNull();
  await intersect(0);
  expect(terminal()).toBeNull();
});

describe('hiding folders and cleaning up (MCR-107)', () => {
  const label = (path: string) => `[aria-label="Folder ${path}"]`;
  const hiddenRows = () => [...host.querySelectorAll('.hs-hidden-row')].map(r => [r.querySelector('.hs-hidden-path')!.getAttribute('title'), r.querySelector('.hs-hidden-why')!.textContent]);
  const openHidden = async () => { const toggle = host.querySelector('.hs-hidden .hs-earlier-toggle') as HTMLButtonElement; if (toggle.getAttribute('aria-expanded') !== 'true') await act(async () => toggle.click()); };

  it('hides a folder without a running session, keeps it in Hidden folders, and shows it again', async () => {
    vi.mocked(harnessApi.list).mockResolvedValue([running]);
    vi.mocked(harnessApi.resumable).mockResolvedValue([{ agent: 'codex', id: 'old-1', cwd: '/Users/me/legacy', modified: 5 }]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    // A folder with a running session has no Hide; one with history only has
    expect(host.querySelector('button[aria-label="Hide folder /work/repo"]')).toBeNull();
    await act(async () => (host.querySelector('button[aria-label="Hide folder /Users/me/legacy"]') as HTMLButtonElement).click());
    expect(host.querySelector(label('/Users/me/legacy'))).toBeNull();
    expect(host.querySelector('.hs-hidden .hs-earlier-toggle')!.textContent).toContain('Hidden folders · 1');
    await openHidden();
    expect(hiddenRows()).toEqual([['/Users/me/legacy', 'hidden by you']]);
    // Kept in the app's settings, not in the harness
    expect(useStore.getState().liveList.hiddenFolders).toEqual(['/Users/me/legacy']);
    await act(async () => (host.querySelector('button[aria-label="Show folder /Users/me/legacy"]') as HTMLButtonElement).click());
    expect(host.querySelector(label('/Users/me/legacy'))).not.toBeNull();
    expect(host.querySelector('.hs-hidden')).toBeNull();
  });

  it('shows a hidden folder again as soon as a session runs there, and hides it again when it has ended', async () => {
    useStore.setState({ liveList: { ...DEFAULT_LIVE_LIST, hiddenFolders: ['/work/repo'] } });
    vi.mocked(harnessApi.list).mockResolvedValue([ended]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(host.querySelector(label('/work/repo'))).toBeNull();
    // A new session there, waiting for the person: it must be in sight
    vi.mocked(harnessApi.list).mockResolvedValue([ended, { ...running, harness: { name: 'Asks', named: true, profile: 'claude', state: 'waiting', since: 1, precise: true, attention: { kind: 'permission', text: 'Bash?', since: 1 }, lastMessage: null } as Hosted['harness'] }]);
    await act(async () => { await new Promise(r => setTimeout(r, 2100)); }); await flush();
    expect(host.querySelector(label('/work/repo'))).not.toBeNull();
    expect(host.querySelector('.hs-hidden')).toBeNull();
    vi.mocked(harnessApi.list).mockResolvedValue([ended]);
    await act(async () => { await new Promise(r => setTimeout(r, 2100)); }); await flush();
    expect(host.querySelector(label('/work/repo'))).toBeNull();
  });

  it('leaves out folders that are gone and agents\' temporary folders, says why, and the switch turns it off', async () => {
    vi.mocked(harnessApi.list).mockResolvedValue([running]);
    vi.mocked(harnessApi.resumable).mockResolvedValue([
      { agent: 'claude', id: 'p1', cwd: '/private/tmp/claude-501/x/scratchpad', modified: 9 },
      { agent: 'claude', id: 'p2', cwd: '/Users/me/work/agent-mcr/.claude/live-check/hooks', modified: 8 },
      { agent: 'codex', id: 'p3', cwd: '/Users/me/api', modified: 7 },
      { agent: 'claude', id: 'p4', cwd: '/Users/me/old', modified: 6, gone: true },
      { agent: 'claude', id: 'p5', cwd: '/Users/me/work/agent-mcr/.claude/worktrees/mcr-49-memory', modified: 5, gone: true },
    ]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(folders().map(f => f.getAttribute('aria-label'))).toEqual(['Folder /work/repo', 'Folder /Users/me/api']);
    await openHidden();
    expect(hiddenRows().sort()).toEqual([
      ['/Users/me/old', 'folder gone'],
      ['/Users/me/work/agent-mcr/.claude/live-check/hooks', 'temporary'],
      ['/Users/me/work/agent-mcr/.claude/worktrees/mcr-49-memory', 'folder gone'],
      ['/private/tmp/claude-501/x/scratchpad', 'temporary'],
    ]);
    // Shown again by the person: the rule does not take it back
    await act(async () => (host.querySelector('button[aria-label="Show folder /private/tmp/claude-501/x/scratchpad"]') as HTMLButtonElement).click());
    expect(host.querySelector(label('/private/tmp/claude-501/x/scratchpad'))).not.toBeNull();
    // The switch off: everything is in the list
    await act(async () => useStore.getState().setLiveList(p => ({ ...p, hideNoise: false })));
    expect(host.querySelector('.hs-hidden')).toBeNull();
    expect(folders()).toHaveLength(6);
  });

  it('hides a past session, and shows the folder\'s hidden ones again', async () => {
    vi.mocked(harnessApi.list).mockResolvedValue([running]);
    vi.mocked(harnessApi.resumable).mockResolvedValue([{ agent: 'claude', id: 'old-1', cwd: '/work/repo', modified: 5, title: 'First try' }, { agent: 'claude', id: 'old-2', cwd: '/work/repo', modified: 4, title: 'Second try' }, { agent: 'codex', id: 'x-1', cwd: '/Users/me/api', modified: 3, title: 'Elsewhere' }]);
    useStore.setState({ liveList: { ...DEFAULT_LIVE_LIST, hiddenSessions: ['x-1'] } });
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const earlier = () => host.querySelector('[aria-label="Folder /work/repo"] .hs-earlier')!;
    expect(earlier().querySelector('.hs-earlier-toggle')!.textContent).toContain('Earlier · 2');
    await act(async () => (earlier().querySelector('.hs-earlier-toggle') as HTMLButtonElement).click());
    await act(async () => (host.querySelector('button[aria-label="Hide session First try"]') as HTMLButtonElement).click());
    expect(earlier().querySelector('.hs-earlier-toggle')!.textContent).toContain('Earlier · 1');
    expect(earlier().textContent).not.toContain('First try');
    // The other folder's only past session is hidden: the folder goes to Hidden folders with that reason
    await openHidden();
    expect(hiddenRows()).toEqual([['/Users/me/api', 'its sessions hidden']]);
    // "show them" brings back this folder's, not the other folder's
    await act(async () => (earlier().querySelector('.hs-earlier-unhide') as HTMLButtonElement).click());
    expect(useStore.getState().liveList.hiddenSessions).toEqual(['x-1']);
    expect(earlier().textContent).toContain('First try');
  });

  it('shows a folder the person hid again also when it is gone or temporary', async () => {
    useStore.setState({ liveList: { ...DEFAULT_LIVE_LIST, hiddenFolders: ['/private/tmp/x/scratchpad'] } });
    vi.mocked(harnessApi.list).mockResolvedValue([running]);
    vi.mocked(harnessApi.resumable).mockResolvedValue([{ agent: 'claude', id: 'p1', cwd: '/private/tmp/x/scratchpad', modified: 9 }]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    await openHidden();
    expect(hiddenRows()).toEqual([['/private/tmp/x/scratchpad', 'hidden by you']]);
    await act(async () => (host.querySelector('button[aria-label="Show folder /private/tmp/x/scratchpad"]') as HTMLButtonElement).click());
    // Not hidden again with the next reason: it is in the list
    expect(host.querySelector(label('/private/tmp/x/scratchpad'))).not.toBeNull();
    expect(host.querySelector('.hs-hidden')).toBeNull();
  });

  it('drops only hidden past sessions that left the history, and keeps every folder choice', async () => {
    useStore.setState({ liveList: { ...DEFAULT_LIVE_LIST, hiddenFolders: ['/Users/me/old', '/Users/me/api'], shownFolders: ['/Users/me/gone-for-good'], hiddenSessions: ['left-history', 'p3'] } });
    vi.mocked(harnessApi.list).mockResolvedValue([running]);
    vi.mocked(harnessApi.resumable).mockResolvedValue([{ agent: 'codex', id: 'p3', cwd: '/Users/me/api', modified: 7 }]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(useStore.getState().liveList).toEqual({ ...DEFAULT_LIVE_LIST, hiddenFolders: ['/Users/me/old', '/Users/me/api'], shownFolders: ['/Users/me/gone-for-good'], hiddenSessions: ['p3'] });
  });

  it('keeps every folder choice when the status arrives last, or without the profile of a folder\'s history', async () => {
    const kept = { ...DEFAULT_LIVE_LIST, hiddenFolders: ['/Users/me/api'], shownFolders: ['/private/tmp/x'] };
    useStore.setState({ liveList: kept });
    vi.mocked(harnessApi.resumable).mockResolvedValue([{ agent: 'codex', id: 'p3', cwd: '/Users/me/api', modified: 7 }]);
    const status = await vi.mocked(harnessApi.status)();
    let arrive: (s: typeof status) => void = () => {};
    vi.mocked(harnessApi.status).mockReturnValue(new Promise(r => { arrive = r; }));
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    await act(async () => arrive({ ...status, profiles: status.profiles.filter(p => p.id !== 'codex') })); await flush();
    expect(useStore.getState().liveList).toEqual(kept);
  });

  it.each(['done', 'needs_human'] as const)('keeps an ended row with an open %s report until it is marked as seen', async report => {
    const dir = '/tmp/reports';
    const reported = withReport({ ...ended, cwd: dir, title: 'Reporter', cwdGone: true }, report, 'Read this report');
    useStore.setState({ liveList: { ...DEFAULT_LIVE_LIST, hiddenFolders: [dir] } });
    vi.mocked(harnessApi.list).mockResolvedValue([running, reported]);
    vi.mocked(harnessApi.ack).mockImplementation(async () => {
      vi.mocked(harnessApi.list).mockResolvedValue([running, { ...reported, harness: { ...reported.harness!, attention: null } }]);
    });
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const row = host.querySelector<HTMLButtonElement>('.hs-dir .needs-you .hs-item')!;
    expect(row.textContent).toContain('Read this report');
    expect(host.querySelector('.hs-cleanup')).toBeNull();
    await act(async () => row.click()); await flush();
    expect(harnessApi.ack).not.toHaveBeenCalled();
    expect(host.querySelector('[data-terminal="e1"]')).not.toBeNull();
    await act(async () => button('Actions for Reporter').click());
    const seen = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.includes('Mark report as seen'))!;
    await act(async () => seen.click()); await flush();
    expect(harnessApi.ack).toHaveBeenCalledWith('e1', 5);
    expect(rows().map(r => r.textContent).join(' ')).not.toContain('Reporter');
    expect(harnessApi.forget).not.toHaveBeenCalled();
    expect(harnessApi.signal).not.toHaveBeenCalled();
  });
});

describe('executors in a worktree below their lead (MCR-133)', () => {
  const lead: Hosted = { ...running, id: 'lead', cwd: '/work/teob-ai', started: 1, harness: { profile: 'claude', state: 'idle', name: 'Lead' } as Hosted['harness'] };
  const wt = '/work/teob-ai/.claude/worktrees/agent-mcr-129';
  const worker: Hosted = { ...running, id: 'w1', cwd: wt, started: 2, harness: { profile: 'claude', state: 'working', name: 'Worker', supervisor: 'lead' } as Hosted['harness'] };

  it('lists the executor in its lead\'s section with a tag, and its folder\'s earlier conversations there too', async () => {
    vi.mocked(harnessApi.list).mockResolvedValue([lead, worker]);
    vi.mocked(harnessApi.resumable).mockResolvedValue([{ agent: 'claude', id: 'old', cwd: '/work/teob-ai/.claude/worktrees/agent-mcr-120', modified: 1, title: 'Earlier worker' }]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(folders().map(f => f.getAttribute('aria-label'))).toEqual(['Folder /work/teob-ai']);
    expect(rows().map(r => [r.getAttribute('data-depth'), r.querySelector('.hs-rel.subdir')?.textContent ?? null])).toEqual([[null, null], ['1', 'agent-mcr-129']]);
    expect(rows()[1].querySelector('.hs-rel.subdir')!.getAttribute('title')).toBe(`Works in ${wt}`);
    await act(async () => (host.querySelector('.hs-earlier-toggle') as HTMLButtonElement).click());
    const earlier = host.querySelector('.hs-earlier-row .hs-resume')!;
    expect(earlier.querySelector('.hs-rel.subdir')?.textContent).toBe('agent-mcr-120');
    expect(earlier.getAttribute('title')).toContain('in /work/teob-ai/.claude/worktrees/agent-mcr-120');
    // A session is still started in the section's own folder
    expect(button('Start a session in /work/teob-ai')).not.toBeNull();
  });
});

describe('Live workspace', () => {
  it('gives its terminals the same session check while the same sessions run, and a new one when that changes', async () => {
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    await act(async () => (host.querySelector('.hs-item') as HTMLButtonElement).click()); await flush();
    givenIsSession.length = 0;
    // Two refreshes of an unchanged list
    await act(async () => { await new Promise(r => setTimeout(r, 4200)); }); await flush();
    expect(givenIsSession).toHaveLength(0);
    // A session ends: the check changes, and says so
    vi.mocked(harnessApi.list).mockResolvedValue([ended, { ...running, exit: { code: 0, signal: null, at: 9 } }]);
    await act(async () => { await new Promise(r => setTimeout(r, 2100)); }); await flush();
    expect(givenIsSession).toHaveLength(1);
    expect((givenIsSession[0] as (id: string) => boolean)('r1')).toBe(false);
  }, 10000);

  it('uses indexed names consistently in the sidebar and terminal header', async () => {
    const session: Hosted = { ...running, title: 'Codex', meta: { profile: 'codex', label: 'Codex' }, harness: { name: 'Codex', named: false, profile: 'codex', state: 'idle', since: 1, precise: true, agentSession: 'conversation', attention: null, lastMessage: null } };
    vi.mocked(harnessApi.list).mockResolvedValue([session]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]} titles={{ conversation: 'Fix authentication retries' }}/>)); await flush();
    expect(host.querySelector('.hs-item strong')?.textContent?.trim()).toBe('Fix authentication retries');
    expect(host.querySelector('.hs-item strong')?.getAttribute('title')).toBe('Fix authentication retries');
    await act(async () => (host.querySelector('.hs-item') as HTMLButtonElement).click()); await flush();
    expect(host.querySelector('.hs-pane:not([hidden]) .hs-pane-title strong')?.textContent).toBe('Fix authentication retries');
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]} titles={{ conversation: 'Repair the cache' }}/>)); await flush();
    expect(host.querySelector('.hs-item strong')?.textContent?.trim()).toBe('Repair the cache');
  });

  it('says that the service could not read its state file, where the file is kept, and lets the person put that away', async () => {
    const status = await vi.mocked(harnessApi.status)();
    const notice = { at: 1, kind: 'partial' as const, kept: '/cfg/harness-state.unread-20261119-220000.json', lost: ['tasks: t2', 'notes: all of it'], why: '', frozen: false };
    vi.mocked(harnessApi.status).mockResolvedValue({ ...status, storeNotice: notice });
    vi.mocked(harnessApi.storeNoticeSeen).mockResolvedValue(null);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const alert = host.querySelector('.hs-store-notice')!;
    expect(alert.textContent).toContain('tasks: t2; notes: all of it');
    expect(alert.textContent).toContain('/cfg/harness-state.unread-20261119-220000.json');
    expect(alert.textContent).toContain('put it back as harness-state.json');
    await act(async () => (alert.querySelector('button') as HTMLButtonElement).click()); await flush();
    expect(harnessApi.storeNoticeSeen).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.hs-store-notice')).toBeNull();
  });

  it('keeps saying that the service saves nothing while it could not keep the unread file', async () => {
    const status = await vi.mocked(harnessApi.status)();
    vi.mocked(harnessApi.status).mockResolvedValue({ ...status, storeNotice: { at: 1, kind: 'unread', kept: '', lost: [], why: 'Syntax error at line 1 column 3', frozen: true } });
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const alert = host.querySelector('.hs-store-notice')!;
    expect(alert.textContent).toContain('started with an empty store');
    expect(alert.textContent).toContain('saves nothing');
    expect(alert.querySelector('button')).toBeNull();
  });

  it('keeps the app visible when a legacy service returns no launch profiles', async () => {
    const status = await vi.mocked(harnessApi.status)();
    vi.mocked(harnessApi.status).mockResolvedValue({ ...status, profiles: null } as unknown as typeof status);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('older harness service');
    expect(button('Add project')).not.toBeNull();
  });

  it('refreshes every launch choice after preferences change and keeps running sessions visible', async () => {
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const status = await vi.mocked(harnessApi.status).mock.results[0].value;
    vi.mocked(harnessApi.status).mockResolvedValue({ ...status, profiles: [{ id: 'pi', label: 'Pi', command: 'pi', optional: true, canSupervise: true, taskTracking: false }], supervisorProfile: 'pi' });
    await act(async () => window.dispatchEvent(new Event(HARNESS_PREFERENCES_CHANGED))); await flush();
    await act(async () => button('Start a session in /work/repo').click());
    expect([...host.querySelectorAll('[role="menuitem"]')].map(b => b.textContent?.trim())).toEqual(['Pi']);
    expect(host.textContent).toContain('Fixing tests');
    expect(host.querySelector('.hs-supervisor-open')?.getAttribute('title')).toContain('Supervisor harness: pi');
    vi.mocked(harnessApi.status).mockResolvedValue({ ...status, profiles: [], supervisorProfile: null });
    await act(async () => window.dispatchEvent(new Event(HARNESS_PREFERENCES_CHANGED))); await flush();
    expect(button('Start a session in /work/repo').disabled).toBe(true);
    expect((host.querySelector('.hs-supervisor-open') as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain('Fixing tests');
  });

  it('lists sessions under their folder, with the state on the dot', async () => {
    await act(async () => root.render(<LiveWorkspace active recentDirectories={['/work/repo']}/>)); await flush();
    // One section per folder, headed by its path (home as ~)
    expect(folders().map(f => [f.querySelector('.hs-dir-path')?.textContent, f.querySelector('.hs-dir-path')?.getAttribute('title')])).toEqual([['/work/repo', '/work/repo']]);
    expect(folders()[0].className).toContain('live');
    const items = [...host.querySelectorAll('.hs-item strong')].map(e => e.textContent?.trim());
    // An unnamed session goes by the title its agent gave it; the agent kind is a mark; the folder is the section
    expect(items).toEqual(['Fixing tests']);
    expect([...host.querySelectorAll('.hs-item .hs-mark')].map(e => e.getAttribute('aria-label'))).toEqual(['Claude Code']);
    // The dot carries the state; pid and output age are not in the row
    expect(rows().map(li => li.textContent).join(' ')).not.toMatch(/pid|output|running/);
    expect(host.querySelector('.hs-dot.running')?.getAttribute('aria-label')).toBe('running');
    expect(host.querySelector('.hs-dot.exited')).toBeNull();
    expect(host.textContent).not.toContain('Runner pid');
  });

  it('drops a naturally ended row on the next poll and resumes its earlier conversation in one click', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
      await act(async () => rows()[0].querySelector('button')!.click()); await flush();
      vi.mocked(harnessApi.list).mockResolvedValue([{ ...running, exit: { code: 0, signal: null, at: Date.now() } }]);
      vi.mocked(harnessApi.resumable).mockResolvedValue([{ id: 'conversation', agent: 'claude', cwd: running.cwd, title: running.title, modified: 5 }]);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); }); await flush();
      expect(rows()).toHaveLength(0);
      expect(host.querySelector('[data-terminal="r1"]')).not.toBeNull();
      expect(harnessApi.forget).not.toHaveBeenCalled();
      const fresh: Hosted = { ...running, id: 'r2' };
      vi.mocked(harnessApi.spawn).mockImplementation(async () => {
        vi.mocked(harnessApi.list).mockResolvedValue([fresh]);
        vi.mocked(harnessApi.resumable).mockResolvedValue([]);
        return fresh;
      });
      await act(async () => host.querySelector<HTMLButtonElement>('.hs-earlier-toggle')!.click());
      await act(async () => host.querySelector<HTMLButtonElement>('.hs-earlier .hs-resume')!.click()); await flush();
      expect(harnessApi.spawn).toHaveBeenCalledWith('', '', 120, 32, 'conversation');
      expect(host.querySelector('[data-terminal="r2"]')).not.toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('has one action menu per row: copy a reference, restart, or close the session for good', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true });
    vi.mocked(harnessApi.signal).mockResolvedValue(); vi.mocked(harnessApi.forget).mockResolvedValue();
    const shell: Hosted = { ...ended, id: 's1', started: 3, exit: null };
    vi.mocked(harnessApi.list).mockResolvedValue([shell, running]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(host.querySelectorAll('.hs-dir .hs-actions button')).toHaveLength(2);
    expect(host.querySelectorAll('.hs-dir-head button')).toHaveLength(1);
    expect(host.querySelector('[role="menu"]')).toBeNull();
    const item = (text: string) => [...host.querySelectorAll('[role="menuitem"]')].find(b => b.textContent?.includes(text)) as HTMLButtonElement;
    await act(async () => button('Actions for Fixing tests').click());
    expect([...host.querySelectorAll('[role="menuitem"]')].map(b => b.textContent?.trim())).toEqual(['New executor (Claude Code) · Preview', 'New executor (Codex) · Preview', 'Connect to supervisor…', 'Copy reference', 'Restart (reload settings)', 'Close session']);
    await act(async () => item('Copy reference').click()); await flush();
    // A pointer, not a paragraph: the id the mcr tools take, and the name for the reader
    expect(copy.mock.calls[0][0]).toBe("mcr:r1 'Fixing tests'");
    // The same pointer travels with a row dragged into a terminal
    const data = new Map<string, string>();
    const drag = new Event('dragstart', { bubbles: true });
    Object.assign(drag, { dataTransfer: { setData: (type: string, value: string) => data.set(type, value) } });
    const live = host.querySelector('.hs-dir .hs-item') as HTMLButtonElement;
    await act(async () => { live.dispatchEvent(drag); });
    expect([...data]).toEqual([['application/x-mcr-session', 'r1'], ['text/plain', "mcr:r1 'Fixing tests'"]]);
    expect(live.getAttribute('draggable')).toBe('true');
    expect(host.querySelector('[role="menu"]')).toBeNull();
    // Restart: the conversation continues under a new id, which takes the old one's place
    const fresh: Hosted = { ...running, id: 'r2' };
    vi.mocked(harnessApi.restart).mockResolvedValue({ ...fresh, replaced: 'r1', resumed: true });
    await act(async () => (host.querySelector('.hs-item') as HTMLButtonElement).click()); await flush();
    await act(async () => button('Actions for Fixing tests').click());
    vi.mocked(harnessApi.list).mockResolvedValue([shell, fresh]);
    await act(async () => item('Restart').click()); await flush();
    expect(harnessApi.restart).toHaveBeenCalledWith('r1');
    expect(host.querySelector('[data-terminal="r1"]')).toBeNull();
    expect(host.querySelector('.hs-pane:not([hidden]) [data-terminal="r2"]')).not.toBeNull();
    // A shell has nothing to continue
    await act(async () => button('Actions for Shell').click());
    expect(item('Restart')).toBeUndefined();
    await act(async () => button('Actions for Shell').click());
    // Close ends the session; once it has ended it is dropped without a second step
    await act(async () => button('Actions for Fixing tests').click());
    vi.mocked(harnessApi.list).mockResolvedValue([shell, { ...fresh, exit: { code: 0, signal: 'HUP', at: 4 } }]);
    await act(async () => item('Close session').click()); await flush();
    expect(harnessApi.signal).toHaveBeenCalledWith('r2', 'HUP');
    expect(harnessApi.forget).not.toHaveBeenCalled();
    expect(host.querySelector('[data-terminal="r2"]')).toBeNull();
    expect(rows().map(r => r.querySelector('strong')?.textContent?.trim())).toEqual(['Shell']);
  });

  it('gives a session restarted in a pane that is not the selected one its terminal', async () => {
    const shell: Hosted = { ...ended, id: 's1', started: 3, exit: null };
    vi.mocked(harnessApi.list).mockResolvedValue([shell, running]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const row = (name: string) => [...host.querySelectorAll('.hs-item')].find(b => b.textContent?.includes(name)) as HTMLButtonElement;
    const item = (text: string) => [...host.querySelectorAll('[role="menuitem"]')].find(b => b.textContent?.includes(text)) as HTMLButtonElement;
    // Two panes: the shell in the first (and selected), the agent in the second
    await act(async () => row('Fixing tests').click()); await flush();
    await act(async () => row('Shell').click()); await flush();
    await act(async () => button('Two columns').click()); await flush();
    expect([...host.querySelectorAll('.hs-layout-root [data-terminal]')].map(t => t.getAttribute('data-terminal'))).toEqual(['s1', 'r1']);
    const fresh: Hosted = { ...running, id: 'r2' };
    vi.mocked(harnessApi.restart).mockResolvedValue({ ...fresh, replaced: 'r1', resumed: true });
    await act(async () => button('Actions for Fixing tests').click());
    vi.mocked(harnessApi.list).mockResolvedValue([shell, fresh]);
    await act(async () => item('Restart').click()); await flush();
    expect(host.querySelector('[data-terminal="r1"]')).toBeNull();
    expect([...host.querySelectorAll('.hs-layout-root [data-terminal]')].map(t => t.getAttribute('data-terminal'))).toEqual(['s1', 'r2']);
  });

  it('goes Back and Forward between the sessions shown, like a browser, and never types (MCR-108)', async () => {
    const shell: Hosted = { ...running, id: 's1', title: '', meta: { label: 'Shell', profile: 'shell' } };
    const third: Hosted = { ...running, id: 't1', title: 'Third one', started: 3 };
    vi.mocked(harnessApi.list).mockResolvedValue([ended, shell, running, third]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const row = (name: string) => [...host.querySelectorAll('.hs-item')].find(b => b.textContent?.includes(name)) as HTMLButtonElement;
    const shown = () => [...host.querySelectorAll('.hs-layout-root [data-terminal]')].map(t => t.getAttribute('data-terminal'));
    const back = () => button('Back'); const forward = () => button('Forward');
    // Nothing shown yet: no buttons
    expect(back()).toBeNull();
    // A row click counts; then a link from that terminal to another session
    await act(async () => row('Fixing tests').click()); await flush();
    expect([back().disabled, forward().disabled]).toEqual([true, true]);
    linkTo = 's1';
    await act(async () => button('link in r1').click()); await flush();
    expect(shown()).toEqual(['s1']);
    expect(back().title).toBe('Back to Fixing tests (Alt+Left)');
    focused.length = 0;
    await act(async () => back().click()); await flush();
    expect(shown()).toEqual(['r1']);
    // Back shows the session; it does not hand it the keyboard, as a link click does
    expect(focused).toEqual([]);
    expect(forward().disabled).toBe(false);
    await act(async () => forward().click()); await flush();
    expect(shown()).toEqual(['s1']);
    expect(forward().disabled).toBe(true);
    // Going somewhere new after Back drops what was ahead
    await act(async () => back().click()); await flush();
    await act(async () => row('Third one').click()); await flush();
    expect(shown()).toEqual(['t1']);
    expect(forward().disabled).toBe(true);
    // An ended session is passed over: r1 ends, Back goes past it to nothing left
    vi.mocked(harnessApi.list).mockResolvedValue([ended, shell, withReport({ ...running, exit: { code: 0, signal: null, at: 9 } }, 'done', 'Result to read'), third]);
    await act(async () => { await new Promise(r => setTimeout(r, 2100)); }); await flush();
    expect(rows().map(r => r.textContent).join(' ')).toContain('Result to read');
    expect(back().disabled).toBe(true);
    // Nothing was ever written to a terminal
    expect(harnessApi.signal).not.toHaveBeenCalled();
    expect(harnessApi.spawn).not.toHaveBeenCalled();
  });

  it('takes the app\'s Back and Forward commands while it is shown, and gives them back when it is not', async () => {
    vi.mocked(harnessApi.list).mockResolvedValue([ended, running, { ...running, id: 't1', title: 'Third one', started: 3 }]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const row = (name: string) => [...host.querySelectorAll('.hs-item')].find(b => b.textContent?.includes(name)) as HTMLButtonElement;
    await act(async () => row('Fixing tests').click()); await flush();
    await act(async () => row('Third one').click()); await flush();
    expect(liveNav.current?.canBack()).toBe(true);
    expect(liveNav.current?.canForward()).toBe(false);
    await act(async () => liveNav.current!.back()); await flush();
    expect([...host.querySelectorAll('.hs-layout-root [data-terminal]')].map(t => t.getAttribute('data-terminal'))).toEqual(['r1']);
    expect(liveNav.current?.canForward()).toBe(true);
    // Another view or Documents shown: the commands go to the document tabs again
    await act(async () => root.render(<LiveWorkspace active={false} recentDirectories={[]}/>));
    expect(liveNav.current).toBeNull();
  });

  it('follows a session pointer clicked in a terminal: that session is shown and its terminal takes the keyboard', async () => {
    const shell: Hosted = { ...running, id: 's1', title: '', meta: { label: 'Shell', profile: 'shell' } };
    vi.mocked(harnessApi.list).mockResolvedValue([ended, shell, running]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const row = (name: string) => [...host.querySelectorAll('.hs-item')].find(b => b.textContent?.includes(name)) as HTMLButtonElement;
    const shown = () => [...host.querySelectorAll('.hs-layout-root [data-terminal]')].map(t => t.getAttribute('data-terminal'));
    const pane = (id: string) => host.querySelector(`[data-terminal="${id}"]`) as HTMLElement;
    await act(async () => row('Fixing tests').click()); await flush();
    expect(shown()).toEqual(['r1']);
    // Running sessions are links; an ended one and an id nobody has are not
    expect(pane('r1').dataset.links).toBe('r1 s1');
    expect(pane('r1').dataset.focusAt).toBe('');
    focused.length = 0;
    // One pane: the linked session takes it
    linkTo = 's1';
    await act(async () => button('link in r1').click()); await flush();
    expect(shown()).toEqual(['s1']);
    expect(row('Shell').closest('li')?.className).toContain('selected');
    expect(focused).toEqual(['s1']);
    // Served: the request is gone, so no later mount of that pane gets it
    expect(pane('s1').dataset.focusAt).toBe('');
    // Two panes, both shown: the click in one marks the other for the keyboard and moves nothing
    await act(async () => button('Two columns').click()); await flush();
    await act(async () => row('Fixing tests').click()); await flush();
    const both = shown();
    expect([...both].sort()).toEqual(['r1', 's1']);
    linkTo = 'r1';
    await act(async () => button('link in s1').click()); await flush();
    expect(shown()).toEqual(both);
    expect(focused).toEqual(['s1', 'r1']);
    expect([pane('r1').dataset.focusAt, pane('s1').dataset.focusAt]).toEqual(['', '']);
    // A pointer to a session that ended, or to nothing, does nothing
    for (const id of ['e1', 'nobody']) {
      linkTo = id;
      await act(async () => button('link in s1').click()); await flush();
      expect(shown()).toEqual(both);
      expect(focused).toEqual(['s1', 'r1']);
    }
    // The linked session's pane mounted again later (here: the session forgotten from the list and back): no keyboard without a click
    // A new status object makes the view read its list again
    const reload = async (list: Hosted[]) => {
      vi.mocked(harnessApi.list).mockResolvedValue(list);
      vi.mocked(harnessApi.status).mockResolvedValue({ ...await harnessApi.status() });
      await act(async () => { window.dispatchEvent(new Event('focus')); }); await flush(); await flush();
    };
    await reload([ended, shell]);
    expect(pane('r1')).toBeNull();
    const before = mounts.filter(id => id === 'r1').length;
    await reload([ended, shell, running]);
    await act(async () => row('Fixing tests').click()); await flush();
    expect(pane('r1')).not.toBeNull();
    expect(mounts.filter(id => id === 'r1').length).toBe(before + 1);
    expect(focused).toEqual(['s1', 'r1']);
  });

  it('keeps a terminal only for a session a pane shows, and mounts it anew when it is shown again (MCR-139)', async () => {
    const shell: Hosted = { ...running, id: 's1', title: '', meta: { label: 'Shell', profile: 'shell' } };
    vi.mocked(harnessApi.list).mockResolvedValue([shell, running]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const row = (name: string) => [...host.querySelectorAll('.hs-item')].find(b => b.textContent?.includes(name)) as HTMLButtonElement;
    const terminals = () => [...host.querySelectorAll('[data-terminal]')].map(t => t.getAttribute('data-terminal'));
    const mountsOf = (id: string) => mounts.filter(m => m === id).length;
    const before = mountsOf('r1');
    await act(async () => row('Fixing tests').click()); await flush();
    expect(terminals()).toEqual(['r1']);
    // Another session in the one pane: the first one's terminal is gone, not kept hidden and streaming
    await act(async () => row('Shell').click()); await flush();
    expect(terminals()).toEqual(['s1']);
    expect(host.querySelector('[hidden] [data-terminal]')).toBeNull();
    // Shown again: a new terminal, which attaches and gets the scrollback from the runner
    await act(async () => row('Fixing tests').click()); await flush();
    expect(terminals()).toEqual(['r1']);
    expect(mountsOf('r1')).toBe(before + 2);
    // Two panes show two sessions: both have their terminal
    await act(async () => button('Two columns').click()); await flush();
    await act(async () => row('Shell').click()); await flush();
    expect(terminals().sort()).toEqual(['r1', 's1']);
  });

  it('sets no new list when a poll brings the same sessions, so the view does not render again (MCR-139)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let lastOutput = 1;
      vi.mocked(harnessApi.list).mockImplementation(() => Promise.resolve([{ ...ended }, { ...running, lastOutput: ++lastOutput }]));
      await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
      const row = (name: string) => [...host.querySelectorAll('.hs-item')].find(b => b.textContent?.includes(name)) as HTMLButtonElement;
      await act(async () => row('Fixing tests').click()); await flush();
      const rendered = renders.length;
      const calls = vi.mocked(harnessApi.list).mock.calls.length;
      // New PTY traffic, same display data: the stamp is unchanged.
      for (let i = 0; i < 3; i++) { await act(async () => { vi.advanceTimersByTime(2000); }); await flush(); }
      expect(vi.mocked(harnessApi.list).mock.calls.length).toBeGreaterThan(calls);
      expect(renders.length).toBe(rendered);
      // A change does come through
      vi.mocked(harnessApi.list).mockImplementation(() => Promise.resolve([{ ...ended }, { ...running, title: 'Writing docs' }]));
      await act(async () => { vi.advanceTimersByTime(2000); }); await flush();
      expect(row('Writing docs')).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('reads the list and the earlier sessions again when the window gets focus, and renders nothing when they are the same (MCR-139)', async () => {
    vi.mocked(harnessApi.list).mockImplementation(() => Promise.resolve([{ ...ended }, { ...running }]));
    vi.mocked(harnessApi.resumable).mockImplementation(() => Promise.resolve([{ agent: 'codex', id: 'old-1', cwd: '/work/repo', modified: 5 }]));
    // Every answer a fresh object with the same content, as from the service
    const base = await harnessApi.status();
    vi.mocked(harnessApi.status).mockImplementation(() => Promise.resolve(JSON.parse(JSON.stringify(base))));
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const row = (name: string) => [...host.querySelectorAll('.hs-item')].find(b => b.textContent?.includes(name)) as HTMLButtonElement;
    await act(async () => row('Fixing tests').click()); await flush();
    const [lists, earlier, statuses, rendered] = [vi.mocked(harnessApi.list).mock.calls.length, vi.mocked(harnessApi.resumable).mock.calls.length, vi.mocked(harnessApi.status).mock.calls.length, renders.length];
    await act(async () => { window.dispatchEvent(new Event('focus')); }); await flush(); await flush();
    expect(vi.mocked(harnessApi.status).mock.calls.length).toBe(statuses + 1);
    expect(vi.mocked(harnessApi.list).mock.calls.length).toBeGreaterThan(lists);
    expect(vi.mocked(harnessApi.resumable).mock.calls.length).toBeGreaterThan(earlier);
    expect(renders.length).toBe(rendered);
  });

  it('takes the terminals away while the Live view itself is hidden, and gives them back when it is shown (MCR-139)', async () => {
    const shell: Hosted = { ...running, id: 's1', title: '', meta: { label: 'Shell', profile: 'shell' } };
    vi.mocked(harnessApi.list).mockResolvedValue([shell, running]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const row = (name: string) => [...host.querySelectorAll('.hs-item')].find(b => b.textContent?.includes(name)) as HTMLButtonElement;
    const terminals = () => [...host.querySelectorAll('[data-terminal]')].map(t => t.getAttribute('data-terminal'));
    await act(async () => row('Fixing tests').click()); await flush();
    await act(async () => row('Shell').click()); await flush();
    await act(async () => button('Two columns').click()); await flush();
    expect(terminals().sort()).toEqual(['r1', 's1']);
    const before = mounts.length;
    // Another view of the Sessions workspace, or another workspace: no terminal streams
    await act(async () => root.render(<LiveWorkspace active={false} recentDirectories={[]}/>)); await flush();
    expect(terminals()).toEqual([]);
    // Back: the same panes, each with its terminal mounted again
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(terminals().sort()).toEqual(['r1', 's1']);
    expect(mounts.length).toBe(before + 2);
  });

  it('lets kept terminals go with their sessions from the list, once the list has been read (MCR-139)', async () => {
    kept.retained = [];
    vi.mocked(harnessApi.list).mockResolvedValue([ended, running]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(kept.retained[kept.retained.length - 1]).toEqual(['e1', 'r1']);
    expect(kept.retained.every(ids => ids.length > 0)).toBe(true);
  });

  it('drops a session the person quit from its own terminal', async () => {
    vi.mocked(harnessApi.forget).mockResolvedValue();
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    await act(async () => (host.querySelector('.hs-item') as HTMLButtonElement).click()); await flush();
    expect(host.querySelector('.hs-pane:not([hidden]) [data-terminal="r1"]')).not.toBeNull();
    // Ctrl-D twice in the terminal: the agent exits, the pane reports it
    vi.mocked(harnessApi.list).mockResolvedValue([ended, { ...running, exit: { code: 0, signal: null, at: 4 } }]);
    await act(async () => button('quit r1').click()); await flush();
    expect(harnessApi.signal).not.toHaveBeenCalled();
    expect(harnessApi.forget).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[data-terminal="r1"]')).toBeNull();
    expect(host.textContent).toContain('Select a session, or start one.');
  });

  it('keeps folders in place: active ones first, then the rest, each by path', async () => {
    const s = (id: string, started: number, cwd: string, extra: Partial<Hosted> = {}): Hosted => ({ ...running, id, started, title: `${id} job`, cwd, ...extra });
    const tracked = { name: '', profile: 'claude', since: 1, precise: true, agentSession: null, lastMessage: null };
    localStorage.setItem('hs-dirs', JSON.stringify(['/Users/me/notes']));
    vi.mocked(harnessApi.list).mockResolvedValue([
      s('one', 9, '/Users/me/api'), s('two', 8, '/Users/me/api', { peers: ['ask'] }),
      s('ask', 2, '/Users/me/web', { harness: { ...tracked, state: 'waiting', attention: { kind: 'permission', text: 'Needs you', since: 5 } } }),
    ]);
    vi.mocked(harnessApi.resumable).mockResolvedValue([{ agent: 'codex', id: 'old-1', cwd: '/Users/me/legacy', modified: 5 }, { agent: 'claude', id: 'old-2', cwd: '/Users/me/api', modified: 4 }]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(folders().map(f => `${f.querySelector('.hs-dir-path')?.textContent}${f.className.includes('live') ? ' (live)' : ''}`)).toEqual(['~/api (live)', '~/web (live)', '~/legacy', '~/notes']);
    expect([...folders()[0].querySelectorAll('.hs-item strong')].map(e => e.textContent?.trim())).toEqual(['two job', 'one job']);
    // Who a session talks to is in its tooltip, wherever the peer runs
    expect(folders()[0].querySelectorAll('.hs-item')[0].getAttribute('title')).toContain('In contact with: ask job');
    // The terminal is headed by the name its session has in the list
    await act(async () => (folders()[0].querySelector('.hs-item') as HTMLButtonElement).click()); await flush();
    expect(host.querySelector('.hs-pane:not([hidden]) .hs-pane-title strong')?.textContent).toBe('two job');
    expect(host.querySelector('.hs-pane:not([hidden]) .hs-pane-title')?.textContent).toContain('/Users/me/api');
    // An added folder with nothing in it can be removed again
    await act(async () => button('Remove folder /Users/me/notes').click());
    expect(folders()).toHaveLength(3);
    expect(localStorage.getItem('hs-dirs')).toBe('[]');
  });

  it.each(['claude', 'codex', 'antigravity', 'pi', 'opencode', 'shell'])('adds a project folder and starts %s inside it', async profile => {
    vi.mocked(harnessApi.list).mockResolvedValue([]);
    vi.mocked(harnessApi.spawn).mockResolvedValue({ ...running, cwd: '/Users/me/new' });
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(host.textContent).toContain('Add a project above');
    vi.mocked(pickDirectory).mockResolvedValue('/Users/me/new/');
    await act(async () => button('Add project').click()); await flush();
    expect(folders().map(f => f.querySelector('.hs-dir-path')?.textContent)).toEqual(['~/new']);
    vi.mocked(harnessApi.list).mockResolvedValue([{ ...running, cwd: '/Users/me/new' }]);
    // One "+" per folder: offer every launch profile supplied by the backend
    await act(async () => button('Start a session in /Users/me/new').click());
    const offered = [...host.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    expect(offered.map(b => b.textContent?.trim())).toEqual(['Claude Code', 'Codex', 'Antigravity', 'Pi', 'OpenCode', 'Terminal']);
    await act(async () => offered[['claude', 'codex', 'antigravity', 'pi', 'opencode', 'shell'].indexOf(profile)].click()); await flush();
    expect(harnessApi.spawn).toHaveBeenCalledWith(profile, '/Users/me/new', 120, 32);
    expect(host.querySelector('[data-terminal="r1"]')).not.toBeNull();
  });

  it('shows what each session is doing and marks the one waiting for the person without moving it', async () => {
    const tracked = { name: '', profile: 'claude', since: 1, precise: true, agentSession: null, lastMessage: null };
    const working: Hosted = { ...running, id: 'w1', openTasks: 2, harness: { ...tracked, state: 'working', attention: null } };
    const blocked: Hosted = { ...running, id: 'b1', harness: { ...tracked, name: 'reviewer', state: 'waiting', attention: { kind: 'permission', text: 'Claude needs your permission to use Bash', since: 5 } } };
    vi.mocked(harnessApi.list).mockResolvedValue([working, blocked]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(host.textContent).toContain('2 tasks');
    expect(host.querySelector('.hs-dot.waiting')?.getAttribute('aria-label')).toBe('waiting for you');
    // One row per session, in start order: the waiting one says why, with no second card for it
    expect(host.querySelector('.hs-notifications')?.textContent).toContain('Notifications · 1');
    expect(rows()).toHaveLength(2);
    expect(rows()[0].className).toContain('needs-you');
    expect(rows()[0].textContent).toContain('reviewer');
    expect(rows()[0].textContent).toContain('Claude needs your permission to use Bash');
    await act(async () => (rows()[0].querySelector('.hs-item') as HTMLButtonElement).click()); await flush();
    expect(host.querySelector('[data-terminal="b1"]')).not.toBeNull();
    expect(harnessApi.ack).not.toHaveBeenCalled();
  });

  it('lists every notification and opens the chosen session without dismissing requests', async () => {
    const tracked = { name: '', profile: 'codex', state: 'idle' as const, since: 1, precise: true, agentSession: null, lastMessage: null };
    const request: Hosted = { ...running, id: 'request', harness: { ...tracked, name: 'Reviewer', attention: { kind: 'assessment', text: 'Which branch?', since: 5 } } };
    const done: Hosted = { ...running, id: 'done', harness: { ...tracked, name: 'Builder', attention: { kind: 'notification', text: 'Build passed', since: 6 } } };
    vi.mocked(harnessApi.list).mockResolvedValue([request, done]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    await act(async () => button('Notifications').click());
    const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map(b => b.textContent)).toEqual([' Reviewer: Which branch?', ' Builder: Build passed']);
    await act(async () => items[1].click()); await flush();
    expect(host.querySelector('.hs-pane:not([hidden]) [data-terminal="done"]')).not.toBeNull();
    expect(harnessApi.ack).toHaveBeenCalledWith('done', 6);
    vi.mocked(harnessApi.ack).mockClear();
    await act(async () => button('Notifications').click());
    await act(async () => (host.querySelector('[role="menuitem"]') as HTMLButtonElement).click()); await flush();
    expect(harnessApi.ack).not.toHaveBeenCalled();
  });

  it('acknowledges new notices in the focused session only while the app is visible', async () => {
    const tracked = { name: '', profile: 'codex', state: 'idle' as const, since: 1, precise: true, agentSession: null, lastMessage: null };
    const session: Hosted = { ...running, harness: { ...tracked, attention: null } };
    vi.mocked(harnessApi.list).mockResolvedValue([session]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    await act(async () => (host.querySelector('.hs-item') as HTMLButtonElement).click()); await flush();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    vi.mocked(harnessApi.list).mockResolvedValue([{ ...session, harness: { ...tracked, attention: { kind: 'notification', text: 'Done', since: 8 } } }]);
    await act(async () => root.render(<LiveWorkspace active={false} recentDirectories={[]}/>));
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(harnessApi.ack).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    vi.mocked(harnessApi.list).mockResolvedValue([session]);
    await act(async () => window.dispatchEvent(new Event('focus'))); await flush();
    expect(harnessApi.ack).toHaveBeenCalledWith('r1', 8);
  });

  it('lists a session\'s subagents under it, with unread messages and its status', async () => {
    const now = Date.now();
    const parent: Hosted = {
      ...running, id: 'p1', unread: 2,
      shells: [
        { pid: 901, command: 'cargo test -p kafka --lib control', started: now - 131_000, cpu: 42, quietSince: now - 5_000 },
        { pid: 902, command: 'kafka-c8c1 control', started: now - 1_500_000, cpu: 1.31, quietSince: now - 1_440_000 },
        { pid: 903, command: 'vim notes', started: now - 60_000, cpu: 0.2, stopped: true, quietSince: now - 1_000 },
      ],
      harness: { name: 'Memory', profile: 'claude', state: 'working', since: 1, precise: true, agentSession: null, lastMessage: null, attention: null, status: 'running the regrade' },
      subagents: [
        { id: 'a1', description: 'MEM-653 false-premise template', agentType: 'general-purpose', model: 'sonnet', started: now - 60_000, lastActivity: now - 5_000 },
        { id: 'b2b2b2b2b2', description: '', agentType: 'Explore', model: '', started: now - 3_000_000, lastActivity: now - 1_800_000 },
        { id: 'c3', description: 'MEM-650 guard', agentType: 'general-purpose', model: 'opus', started: now - 3_000_000, lastActivity: now - 2_000_000, finished: true },
      ],
    };
    vi.mocked(harnessApi.list).mockResolvedValue([parent]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(host.textContent).toContain('2 unread');
    // What it is doing, in its own words, after how long it has been at it
    expect(host.querySelector('.hs-status')?.textContent).toMatch(/^Working \d+h \d+mrunning the regrade$/);
    // A shell command it left running, with how long
    const shell = [...host.querySelectorAll('.hs-shells li')];
    expect(shell.map(li => li.className)).toEqual(['active', 'quiet', 'stopped']);
    expect(shell[0].textContent).toBe('cargo test -p kafka --lib control2m');
    expect(shell[0].getAttribute('title')).toContain('pid 901');
    // No processor use for a long time: said as quiet, since waiting and stuck look alike
    expect(shell[1].textContent).toBe('kafka-c8c1 controlquiet 24m · 25m');
    expect(shell[1].getAttribute('title')).toContain('1.3s of processor time');
    expect(shell[1].getAttribute('title')).toContain('may be waiting');
    expect(shell[2].textContent).toBe('vim notesstopped · 1m');
    const subs = [...host.querySelectorAll('.hs-subs:not(.hs-shells) li')];
    // Finished ones are not shown; the rest are one line each, details in the tooltip
    expect(subs.map(li => li.className)).toEqual(['active', '']);
    expect(subs[0].textContent).toBe('MEM-653 false-premise template');
    expect(subs[0].getAttribute('title')).toContain('general-purpose · sonnet · active');
    expect(subs[1].textContent).toBe('Subagent b2b2b2b2');
    // A subagent has no terminal: its row is not a button
    expect(subs[0].querySelector('button')).toBeNull();
  });

  it('opens the supervisor with one click and keeps it on top', async () => {
    const boss: Hosted = { ...running, id: 'sup1', started: 1, meta: { profile: 'claude', name: 'Supervisor', role: 'supervisor' } };
    vi.mocked(harnessApi.supervisor).mockResolvedValue(boss);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const open = host.querySelector('.hs-supervisor-open') as HTMLButtonElement;
    expect(open.textContent).toContain('Open supervisor');
    vi.mocked(harnessApi.list).mockResolvedValue([ended, running, boss]);
    await act(async () => open.click()); await flush();
    expect(harnessApi.supervisor).toHaveBeenCalledWith(120, 32);
    expect(host.querySelector('[data-terminal="sup1"]')).not.toBeNull();
    // Its own tile above the list, not a row in it
    expect(host.querySelector('.hs-supervisor')?.className).toContain('running selected');
    expect(host.querySelector('.hs-supervisor strong')?.textContent).toBe('Supervisor');
    expect(rows()).toHaveLength(1);
    expect(folders()).toHaveLength(1);
    expect(button('Actions for the supervisor')).not.toBeNull();
    // A second click selects the running one instead of starting another
    await act(async () => (host.querySelector('.hs-supervisor-open') as HTMLButtonElement).click()); await flush();
    expect(harnessApi.supervisor).toHaveBeenCalledTimes(1);
  });

  it('resumes an earlier session from inside its folder', async () => {
    vi.mocked(harnessApi.list).mockResolvedValue([]);
    const now = Date.now();
    vi.mocked(harnessApi.resumable).mockResolvedValue([
      { agent: 'codex', id: 'aaaaaaaa-1111-4111-8111-111111111111', cwd: '/work/api', modified: now - 1000 },
      { agent: 'claude', id: 'bbbbbbbb-1111-4111-8111-111111111111', cwd: '/work/api', modified: now - 2000 },
    ]);
    vi.mocked(harnessApi.spawn).mockResolvedValue(running);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]} titles={{ 'aaaaaaaa-1111-4111-8111-111111111111': 'Fix the retention job' }}/>)); await flush();
    // A folder with only history: its earlier sessions are one click away
    const toggle = host.querySelector('.hs-earlier-toggle') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Earlier · 2 · last just now');
    expect(host.querySelector('.hs-resume')).toBeNull();
    await act(async () => toggle.click());
    // Newest first; the title comes from the Sessions index when it has one
    expect([...host.querySelectorAll('.hs-resume strong')].map(e => e.textContent?.trim())).toEqual(['Fix the retention job', 'Claude session']);
    await act(async () => (host.querySelector('.hs-resume') as HTMLButtonElement).click()); await flush();
    expect(harnessApi.spawn).toHaveBeenCalledWith('', '', 120, 32, 'aaaaaaaa-1111-4111-8111-111111111111');
  });

  it('opens the search for a folder and shows why a start was refused', async () => {
    const onSearch = vi.fn();
    vi.mocked(harnessApi.spawn).mockRejectedValue('Start sessions in a folder you opened');
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]} onSearch={onSearch}/>)); await flush();
    await act(async () => button('Search the history of /work/repo').click());
    expect(onSearch).toHaveBeenCalledWith('/work/repo');
    await act(async () => button('Start a session in /work/repo').click());
    await act(async () => (host.querySelector('[role="menuitem"]') as HTMLButtonElement).click()); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Start sessions in a folder you opened');
  });

  it('asks before anything runs in the background, and starts once allowed', async () => {
    const status = await harnessApi.status();
    vi.mocked(harnessApi.status).mockRejectedValueOnce(new Error('Background processes are not allowed'));
    vi.mocked(harnessApi.background).mockResolvedValue({ consent: 'new', units: [], sessions: 0 });
    vi.mocked(harnessApi.allowBackground).mockResolvedValue(true);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const gate = host.querySelector('.hs-gate') as HTMLElement;
    expect(gate.textContent).toContain('Nothing is installed or started until you allow it');
    expect(harnessApi.list).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    vi.mocked(harnessApi.status).mockResolvedValue(status);
    await act(async () => (gate.querySelector('button') as HTMLButtonElement).click()); await flush();
    expect(harnessApi.allowBackground).toHaveBeenCalled();
    expect(host.querySelector('.hs-gate')).toBeNull();
    expect(host.textContent).not.toContain('Runner pid');
    expect(host.querySelector('.hs-dir')).not.toBeNull();
  });
});
