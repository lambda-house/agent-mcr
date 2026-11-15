// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveWorkspace from './LiveWorkspace';
import { harnessApi, type Hosted } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(), list: vi.fn(), spawn: vi.fn(), signal: vi.fn(), forget: vi.fn(), resumable: vi.fn(), ack: vi.fn(), supervisor: vi.fn() } }));
vi.mock('../utils/tauri', () => ({ isTauri: () => true, pickDirectory: vi.fn() }));
vi.mock('../utils/agent', () => ({ formatAge: () => 'just now' }));
// Terminals need a real canvas; the pane itself is exercised in the app
vi.mock('./TerminalPane', () => ({ default: ({ id }: { id: string }) => <div data-terminal={id}/> }));

const running: Hosted = { id: 'r1', pid: 42, argv: ['/bin/zsh', '-l', '-i', '-c', 'exec claude'], cwd: '/work/repo', started: 2, cols: 120, rows: 32, title: 'Fixing tests', lastOutput: 1, exit: null, meta: { label: 'Claude Code', profile: 'claude' } };
const ended: Hosted = { ...running, id: 'e1', started: 1, title: '', exit: { code: 0, signal: null, at: 3 }, meta: { label: 'Shell', profile: 'shell' } };

let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.status).mockResolvedValue({ runner: { protocol: 1, pid: 7, version: '0.1.0', exe: '/x' }, profiles: [{ id: 'claude', label: 'Claude Code', command: 'claude' }, { id: 'shell', label: 'Shell', command: '' }], home: '/Users/me' });
  vi.mocked(harnessApi.list).mockResolvedValue([ended, running]);
  vi.mocked(harnessApi.resumable).mockResolvedValue([]);
  vi.mocked(harnessApi.ack).mockResolvedValue();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Live workspace', () => {
  it('lists running sessions first with their state and offers the right actions', async () => {
    await act(async () => root.render(<LiveWorkspace active recentDirectories={['/work/repo']}/>)); await flush();
    const items = [...host.querySelectorAll('.hs-item strong')].map(e => e.textContent?.trim());
    // An unnamed session goes by the title its agent gave it; the agent kind is a mark
    expect(items).toEqual(['Fixing tests · repo', 'Shell · repo']);
    expect([...host.querySelectorAll('.hs-item .hs-mark')].map(e => e.getAttribute('aria-label'))).toEqual(['Claude Code', 'Shell']);
    expect(host.querySelector('.hs-title')).toBeNull();
    expect(host.textContent).toContain('running · pid 42');
    expect(host.textContent).toContain('exited with 0');
    expect(host.textContent).toContain('Runner pid 7 · 1 running');
    expect(host.querySelectorAll('button[aria-label="Interrupt"]')).toHaveLength(1);
    expect(host.querySelectorAll('button[aria-label="Forget"]')).toHaveLength(1);
    vi.mocked(harnessApi.signal).mockResolvedValue();
    await act(async () => button('Interrupt').click()); await flush();
    expect(harnessApi.signal).toHaveBeenCalledWith('r1', 'INT');
  });

  it('starts a profile in the chosen folder and opens its terminal', async () => {
    vi.mocked(harnessApi.spawn).mockResolvedValue(running);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect((host.querySelector('input[aria-label="Working folder"]') as HTMLInputElement).value).toBe('/Users/me');
    await act(async () => (host.querySelector('.hs-start') as HTMLButtonElement).click()); await flush();
    expect(harnessApi.spawn).toHaveBeenCalledWith('claude', '/Users/me', 120, 32);
    expect(host.querySelector('[data-terminal="r1"]')).not.toBeNull();
  });

  it('shows what each session is doing and puts the ones waiting for the person on top', async () => {
    const tracked = { name: '', profile: 'claude', since: 1, precise: true, agentSession: null, lastMessage: null };
    const working: Hosted = { ...running, id: 'w1', openTasks: 2, harness: { ...tracked, state: 'working', attention: null } };
    const blocked: Hosted = { ...running, id: 'b1', cwd: '/work/api', harness: { ...tracked, name: 'reviewer', state: 'waiting', attention: { kind: 'permission', text: 'Claude needs your permission to use Bash', since: 5 } } };
    vi.mocked(harnessApi.list).mockResolvedValue([working, blocked]);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    expect(host.textContent).toContain('working · 2 tasks · pid 42');
    expect(host.querySelector('.hs-dot.waiting')?.getAttribute('aria-label')).toBe('waiting for you');
    // One row per session: the waiting one is first and says why, with no second card for it
    expect(host.querySelector('.hs-attention')?.textContent).toContain('1 session is waiting for you');
    const rows = [...host.querySelectorAll('.hs-list li')];
    expect(rows).toHaveLength(2);
    expect(rows[0].className).toContain('needs-you');
    expect(rows[0].textContent).toContain('reviewer · api');
    expect(rows[0].textContent).toContain('Claude needs your permission to use Bash');
    await act(async () => (rows[0].querySelector('.hs-item') as HTMLButtonElement).click()); await flush();
    expect(host.querySelector('[data-terminal="b1"]')).not.toBeNull();
    expect(harnessApi.ack).not.toHaveBeenCalled();
  });

  it('lists a session\'s subagents under it, with unread messages and its status', async () => {
    const now = Date.now();
    const parent: Hosted = {
      ...running, id: 'p1', unread: 2,
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
    expect(host.querySelector('.hs-status')?.textContent).toBe('running the regrade');
    const subs = [...host.querySelectorAll('.hs-subs li')];
    // Finished ones are only counted
    expect(subs.map(li => li.className)).toEqual(['active', '', 'hs-subs-done']);
    expect(subs[2].textContent).toBe('1 finished in the last hour');
    expect(subs[0].textContent).toBe('MEM-653 false-premise templategeneral-purpose · sonnet · active');
    expect(subs[1].textContent).toBe('Subagent b2b2b2b2Explore · quiet, last activity just now');
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
    expect(host.querySelectorAll('.hs-list ul > li')).toHaveLength(2);
    expect(button('Stop the supervisor')).not.toBeNull();
    // A second click selects the running one instead of starting another
    await act(async () => (host.querySelector('.hs-supervisor-open') as HTMLButtonElement).click()); await flush();
    expect(harnessApi.supervisor).toHaveBeenCalledTimes(1);
  });

  it('resumes an earlier session from its transcript, not from the form', async () => {
    vi.mocked(harnessApi.resumable).mockResolvedValue([{ agent: 'codex', id: 'aaaaaaaa-1111-4111-8111-111111111111', cwd: '/work/api', modified: 1 }]);
    vi.mocked(harnessApi.spawn).mockResolvedValue(running);
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    const pick = host.querySelector('select[aria-label="Resume an earlier session"]') as HTMLSelectElement;
    expect(pick.options[1].textContent).toBe('Codex · api · just now');
    await act(async () => { pick.value = pick.options[1].value; pick.dispatchEvent(new Event('change', { bubbles: true })); });
    expect((host.querySelector('.hs-start') as HTMLButtonElement).textContent).toContain('Resume');
    await act(async () => (host.querySelector('.hs-start') as HTMLButtonElement).click()); await flush();
    expect(harnessApi.spawn).toHaveBeenCalledWith('', '', 120, 32, 'aaaaaaaa-1111-4111-8111-111111111111');
  });

  it('shows why a start was refused', async () => {
    vi.mocked(harnessApi.spawn).mockRejectedValue('Start sessions in a folder you opened');
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    await act(async () => (host.querySelector('.hs-start') as HTMLButtonElement).click()); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Start sessions in a folder you opened');
  });
});
