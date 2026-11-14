// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveWorkspace from './LiveWorkspace';
import { harnessApi, type Hosted } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(), list: vi.fn(), spawn: vi.fn(), signal: vi.fn(), forget: vi.fn(), resumable: vi.fn(), ack: vi.fn() } }));
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
    const items = [...host.querySelectorAll('.hs-item strong')].map(e => e.textContent);
    expect(items).toEqual(['Claude Code · repo', 'Shell · repo']);
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
