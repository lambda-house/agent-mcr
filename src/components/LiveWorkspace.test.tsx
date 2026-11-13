// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveWorkspace from './LiveWorkspace';
import { harnessApi, type Hosted } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(), list: vi.fn(), spawn: vi.fn(), signal: vi.fn(), forget: vi.fn() } }));
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

  it('shows why a start was refused', async () => {
    vi.mocked(harnessApi.spawn).mockRejectedValue('Start sessions in a folder you opened');
    await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>)); await flush();
    await act(async () => (host.querySelector('.hs-start') as HTMLButtonElement).click()); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Start sessions in a folder you opened');
  });
});
