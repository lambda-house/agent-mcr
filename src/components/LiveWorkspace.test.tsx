// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveWorkspace from './LiveWorkspace';
import { HARNESS_PREFERENCES_CHANGED, harnessApi, type Hosted } from '../utils/harness';
import { pickDirectory } from '../utils/tauri';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(), list: vi.fn(), spawn: vi.fn(), signal: vi.fn(), forget: vi.fn(), restart: vi.fn(), resumable: vi.fn(), ack: vi.fn(), supervisor: vi.fn(), background: vi.fn(), allowBackground: vi.fn(), stopBackground: vi.fn() } }));
vi.mock('../utils/tauri', () => ({ isTauri: () => true, pickDirectory: vi.fn() }));
vi.mock('../utils/agent', () => ({ formatAge: () => 'just now' }));
// Terminals need a real canvas; the pane itself is exercised in the app
vi.mock('./TerminalPane', () => ({ default: ({ id, onQuit }: { id: string; onQuit?: () => void }) => <div data-terminal={id}><button aria-label={`quit ${id}`} onClick={onQuit}/></div> }));

const running: Hosted = { id: 'r1', pid: 42, argv: ['/bin/zsh', '-l', '-i', '-c', 'exec claude'], cwd: '/work/repo', started: 2, cols: 120, rows: 32, title: 'Fixing tests', lastOutput: 1, exit: null, meta: { label: 'Claude Code', profile: 'claude' } };
const ended: Hosted = { ...running, id: 'e1', started: 1, title: '', exit: { code: 0, signal: null, at: 3 }, meta: { label: 'Shell', profile: 'shell' } };

let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.removeItem('hs-dirs');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.status).mockResolvedValue({ runner: { protocol: 1, pid: 7, version: '0.1.0', exe: '/x' }, profiles: [{ id: 'claude', label: 'Claude Code', command: 'claude', optional: false, canSupervise: true, taskTracking: true }, { id: 'codex', label: 'Codex', command: 'codex', optional: false, canSupervise: true, taskTracking: true }, { id: 'antigravity', label: 'Antigravity', command: 'agy --mode accept-edits', optional: true, canSupervise: true, taskTracking: false }, { id: 'pi', label: 'Pi', command: 'pi', optional: true, canSupervise: true, taskTracking: false }, { id: 'opencode', label: 'OpenCode', command: 'opencode', optional: true, canSupervise: true, taskTracking: false }, { id: 'shell', label: 'Terminal', command: '', optional: false, canSupervise: false, taskTracking: false }], supervisorProfile: 'claude', home: '/Users/me' });
  vi.mocked(harnessApi.list).mockResolvedValue([ended, running]);
  vi.mocked(harnessApi.resumable).mockResolvedValue([]);
  vi.mocked(harnessApi.ack).mockResolvedValue();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const rows = () => [...host.querySelectorAll('.hs-dir > ul > li')];
const folders = () => [...host.querySelectorAll('.hs-dir')];

describe('Live workspace', () => {
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
    expect(items).toEqual(['Fixing tests', 'Shell']);
    expect([...host.querySelectorAll('.hs-item .hs-mark')].map(e => e.getAttribute('aria-label'))).toEqual(['Claude Code', 'Shell']);
    // The dot carries the state; pid and output age are not in the row
    expect(rows().map(li => li.textContent).join(' ')).not.toMatch(/pid|output|running/);
    expect(host.querySelector('.hs-dot.running')?.getAttribute('aria-label')).toBe('running');
    expect(host.querySelector('.hs-dot.exited')?.getAttribute('aria-label')).toBe('exited');
    expect(host.textContent).not.toContain('Runner pid');
  });

  it('keeps ended sessions in the list in exited state, allows viewing output and removing them', async () => {
    vi.mocked(harnessApi.forget).mockResolvedValue();
    vi.mocked(harnessApi.list).mockResolvedValue([running, { ...ended, cwd: '/work/finished' }]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(folders().map(f => f.querySelector('.hs-dir-path')?.getAttribute('title'))).toEqual(['/work/repo', '/work/finished']);
    expect(host.querySelector('.hs-dot.exited')?.getAttribute('aria-label')).toBe('exited');
    const endedButton = [...host.querySelectorAll('.hs-dir .hs-item')].find(b => b.textContent?.includes('Shell')) as HTMLButtonElement;
    await act(async () => endedButton.click()); await flush();
    expect(host.querySelector('.hs-pane:not([hidden]) [data-terminal="e1"]')).not.toBeNull();
    await act(async () => button('Actions for Shell').click());
    const remove = [...host.querySelectorAll('[role="menuitem"]')].find(b => b.textContent?.includes('Remove from the list')) as HTMLButtonElement;
    expect(remove).toBeTruthy();
    await act(async () => remove.click()); await flush();
    expect(harnessApi.forget).toHaveBeenCalledWith('e1');
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
    expect(harnessApi.forget).toHaveBeenCalledWith('r2');
    expect(harnessApi.forget).not.toHaveBeenCalledWith('e1');
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

  it('drops a session the person quit from its own terminal', async () => {
    vi.mocked(harnessApi.forget).mockResolvedValue();
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    await act(async () => (host.querySelector('.hs-item') as HTMLButtonElement).click()); await flush();
    expect(host.querySelector('.hs-pane:not([hidden]) [data-terminal="r1"]')).not.toBeNull();
    // Ctrl-D twice in the terminal: the agent exits, the pane reports it
    vi.mocked(harnessApi.list).mockResolvedValue([ended, { ...running, exit: { code: 0, signal: null, at: 4 } }]);
    await act(async () => button('quit r1').click()); await flush();
    expect(harnessApi.signal).not.toHaveBeenCalled();
    expect(harnessApi.forget).toHaveBeenCalledWith('r1');
    expect(harnessApi.forget).not.toHaveBeenCalledWith('e1');
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
    expect(rows()).toHaveLength(2);
    expect(folders()).toHaveLength(1);
    expect(button('Actions for the supervisor')).not.toBeNull();
    // A second click selects the running one instead of starting another
    await act(async () => (host.querySelector('.hs-supervisor-open') as HTMLButtonElement).click()); await flush();
    expect(harnessApi.supervisor).toHaveBeenCalledTimes(1);
  });

  it('resumes an earlier session from inside its folder', async () => {
    vi.mocked(harnessApi.list).mockResolvedValue([]);
    vi.mocked(harnessApi.resumable).mockResolvedValue([
      { agent: 'codex', id: 'aaaaaaaa-1111-4111-8111-111111111111', cwd: '/work/api', modified: 9 },
      { agent: 'claude', id: 'bbbbbbbb-1111-4111-8111-111111111111', cwd: '/work/api', modified: 5 },
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
