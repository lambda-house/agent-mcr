// @vitest-environment happy-dom
// A clicked macOS banner through the real parents (MCR-180 round 4, 17360):
// the page's banner handler in App, SessionWorkspace, LiveWorkspace and real
// terminal panes on xterm's own parser. Only the native side, the harness
// calls and the Documents surface are stand-ins.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal as Headless } from '@xterm/headless';
import App from './App';
import { harnessApi, type Hosted } from './utils/harness';
import { useBannerIntent } from './utils/bannerIntent';
import { keep } from './components/TerminalPane';

const native = vi.hoisted(() => ({ clicks: [] as unknown[], listeners: new Map<string, () => void>() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => command === 'harness_open_session_take' ? native.clicks.shift() ?? null : null),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: () => void) => { native.listeners.set(name, handler); return () => native.listeners.delete(name); }) }));
const made = vi.hoisted(() => ({ terms: [] as unknown[] }));
vi.mock('@xterm/xterm', async () => {
  const { Terminal: Real } = await import('@xterm/headless');
  class Terminal extends Real {
    element?: HTMLElement;
    textarea?: HTMLTextAreaElement;
    constructor(options: ConstructorParameters<typeof Real>[0]) { super({ ...options, allowProposedApi: true }); made.terms.push(this); }
    open(parent: HTMLElement) { this.element = document.createElement('div'); this.textarea = document.createElement('textarea'); this.element.appendChild(this.textarea); parent.appendChild(this.element); }
    onKey() { return { dispose() {} }; }
    registerLinkProvider() { return { dispose() {} }; }
    registerDecoration() { return undefined; }
    onRender() { return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    focus() { this.textarea?.focus(); }
    refresh() {}
    hasSelection() { return false; }
    getSelection() { return ''; }
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} fit() {} dispose() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('./utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: {
  status: vi.fn(), list: vi.fn(), listSince: vi.fn(), resumable: vi.fn(), ack: vi.fn(), background: vi.fn(),
  attach: vi.fn(), detach: vi.fn(), resize: vi.fn(() => Promise.resolve()), input: vi.fn(), saveImage: vi.fn(),
} }));
vi.mock('./utils/sessions', async importOriginal => ({ ...await importOriginal<object>(), sessionApi: { access: vi.fn(async () => false), snapshot: vi.fn(), journalSince: vi.fn(), detail: vi.fn() } }));
// The Documents surface is not what this is about
vi.mock('./components/Toolbar', () => ({ default: () => <div data-toolbar/> }));
vi.mock('./components/AgentPanel', () => ({ default: () => null }));
vi.mock('./components/DocumentPanel', () => ({ default: () => null }));
vi.mock('./components/TocSidebar', () => ({ default: () => null }));
vi.mock('./components/StatusBar', () => ({ default: () => null }));
vi.mock('./utils/agent', async importOriginal => ({ ...await importOriginal<object>(), refreshAgentWorkspace: vi.fn(async () => {}), agentFilesWatched: () => true }));

const running: Hosted = { id: 'r1', pid: 42, argv: ['/bin/zsh', '-l', '-i', '-c', 'exec claude'], cwd: '/work/repo', started: 2, cols: 120, rows: 32, title: 'Fixing tests', lastOutput: 1, exit: null, meta: { label: 'Claude Code', profile: 'claude' } };
const other: Hosted = { ...running, id: 'r2', pid: 43, title: 'Other work', started: 3 };
const done = (h: Hosted, since: number): Hosted => ({ ...h, harness: { name: '', profile: 'claude', state: 'idle', since: 1, precise: true, agentSession: null, lastMessage: null,
  attention: { report: 'done', kind: 'notification', text: 'Finished', since } } });

let root: Root; let host: HTMLDivElement;
let listed: Hosted[];
let views: { id: string; on: { start: (from: number | null) => void; data: (bytes: Uint8Array) => void } }[];
/** While set, every list read waits for it */
let held: Promise<void> | null;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const frame = async () => { await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(null))); }); };
const holdReads = () => { let release!: () => void; held = new Promise(resolve => { release = resolve; }); return async () => { held = null; await act(async () => release()); await flush(); await frame(); }; };
type Term = Headless & { textarea: HTMLTextAreaElement };
/** The terminal a pane shows now, by the session title in its head: a remount may have made a new one */
const termOf = (title: string) => {
  const pane = [...host.querySelectorAll('.hs-pane:not([hidden])')].find(p => p.querySelector('.hs-pane-title')?.textContent?.includes(title));
  const textarea = pane?.querySelector('textarea');
  return (made.terms as Term[]).find(t => t.textarea === textarea)!;
};
/** The output stream of the latest view of a session */
const streamOf = (id: string) => { const mine = views.filter(v => v.id === id); return mine[mine.length - 1].on; };
/** Output from the runner, parsed */
const output = async (id: string, t: Headless, text: string) => {
  await act(async () => { const on = streamOf(id); on.start(0); on.data(new TextEncoder().encode(text)); });
  await act(async () => { await new Promise<void>(resolve => t.write('', resolve)); });
};
const shown = () => [...host.querySelectorAll('.hs-pane:not([hidden]) .hs-pane-title')].map(e => ['Fixing tests', 'Other work'].find(t => e.textContent?.includes(t)));
/** What the browser xterm sends by itself while DECSET 1004 is on: its focus report */
const report = (t: Headless, focused: boolean) => { if (t.modes.sendFocusMode) t.input(focused ? '\x1b[I' : '\x1b[O', false); };
/** A click on a banner, as the native side hands it to the page */
const banner = async (session: string | null) => { native.clicks.push({ session }); await act(async () => native.listeners.get('harness-open-session')!()); await flush(); };
const sessionsButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.workspace-switch-option')].find(b => b.textContent?.includes(label))!;
const row = (title: string) => [...host.querySelectorAll<HTMLButtonElement>('button.hs-item')].find(b => b.textContent?.includes(title))!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  localStorage.setItem('agent-mcr.sessions.view', 'live');
  keep.protect(new Set()); keep.retain(new Set());
  native.clicks = []; native.listeners.clear(); made.terms = []; views = []; held = null;
  useBannerIntent.setState({ intent: null });
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: (entries: Partial<ResizeObserverEntry>[]) => void) {}
    observe() { this.callback([{ contentRect: new DOMRect(0, 0, 600, 400) }]); }
    disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
    observe() { this.callback([{ isIntersecting: true, intersectionRect: new DOMRect(0, 0, 600, 400) }]); }
    unobserve() {} disconnect() {} takeRecords() { return []; }
  });
  vi.mocked(harnessApi.status).mockResolvedValue({ runner: { protocol: 1, pid: 7, version: '0.1.0', exe: '/x' }, profiles: [{ id: 'claude', label: 'Claude Code', command: 'claude', optional: false, canSupervise: true, taskTracking: true }], supervisorProfile: 'claude', home: '/Users/me' });
  listed = [done(running, 5), other];
  vi.mocked(harnessApi.listSince).mockImplementation(async stamp => {
    if (held) await held;
    const now = JSON.stringify(listed);
    return { stamp: now, sessions: now === stamp ? null : listed };
  });
  vi.mocked(harnessApi.resumable).mockResolvedValue([]);
  vi.mocked(harnessApi.ack).mockResolvedValue();
  vi.mocked(harnessApi.input).mockResolvedValue(undefined);
  let handle = 0;
  vi.mocked(harnessApi.attach).mockImplementation((id, _since, on) => { views.push({ id, on }); return Promise.resolve(++handle); });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

/**
 * The operator looked at r1 earlier, while the window was in the background
 * (so its done mark stands), and its agent turned on focus reports. Then
 * they went to Documents, and the window has the focus now.
 */
async function r1SelectedThenDocuments() {
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  await act(async () => root.render(<App/>)); await flush(); await flush();
  await act(async () => row('Fixing tests').click()); await flush(); await frame();
  const t1 = termOf('Fixing tests');
  await output('r1', t1, '\x1b[?1004hworking\r\n');
  expect(t1.modes.sendFocusMode).toBe(true);
  t1.textarea.blur();
  await act(async () => sessionsButton('Documents').click()); await flush();
  expect(host.querySelector('[data-toolbar]')).not.toBeNull();
  vi.mocked(harnessApi.input).mockClear();
  focus.mockReturnValue(true);
  return t1;
}

describe('a clicked banner, from the page handler down to the terminals (MCR-180)', () => {
  it('sends no acknowledgement for any session while its ask is pending, nor for the view it showed', async () => {
    await r1SelectedThenDocuments();
    const release = holdReads();
    await banner('r2');
    // Documents → Sessions → Live in one render, with the ask: r1's mark stays
    expect(sessionsButton('Sessions').getAttribute('aria-current')).toBe('page');
    expect(useBannerIntent.getState().intent?.id).toBe('r2');
    await act(async () => { window.dispatchEvent(new Event('focus')); }); await flush();
    expect(harnessApi.ack).not.toHaveBeenCalled();
    await release();
    expect(useBannerIntent.getState().intent).toBeNull();
    expect(shown()).toContain('Other work');
    listed = [done(running, 5), done(other, 6)];
    await act(async () => { window.dispatchEvent(new Event('focus')); }); await flush(); await flush();
    expect(harnessApi.ack).not.toHaveBeenCalled();
    // The operator's own row click: as before
    await act(async () => row('Other work').click()); await flush();
    expect(harnessApi.ack).toHaveBeenCalledWith('r2', 6);
  });

  it('gives no terminal the keyboard and lets none send anything while the ask is pending, until the operator types', async () => {
    await r1SelectedThenDocuments();
    const release = holdReads();
    await banner('r2');
    await frame(); await frame();
    // The terminal selected before is shown again, but takes no keyboard and sends no report
    expect(shown()).toContain('Fixing tests');
    const t1 = termOf('Fixing tests');
    if (!t1.modes.sendFocusMode) await output('r1', t1, '\x1b[?1004h');
    expect(document.activeElement).not.toBe(t1.textarea);
    await act(async () => { t1.textarea.dispatchEvent(new FocusEvent('focus')); report(t1, true); t1.input('\x1b[2;1R', false); });
    expect(harnessApi.input).not.toHaveBeenCalled();
    await release();
    const t2 = termOf('Other work');
    await output('r2', t2, '\x1b[?1004h');
    await frame();
    expect(document.activeElement).not.toBe(t2.textarea);
    await act(async () => { report(t2, false); });
    expect(harnessApi.input).not.toHaveBeenCalled();
    // The operator's own key in it: the key goes out, and the view is theirs
    await act(async () => { t2.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true })); t2.input('x', true); });
    expect(vi.mocked(harnessApi.input).mock.calls.map(c => c[1])).toEqual(['x']);
  });

  it('opens nothing for an ask the page took when a later click is about no session', async () => {
    await r1SelectedThenDocuments();
    const release = holdReads();
    await banner('r2');
    expect(useBannerIntent.getState().intent?.id).toBe('r2');
    // The state file's banner, clicked while the list read for r2 is under way
    await banner(null);
    expect(useBannerIntent.getState().intent).toBeNull();
    await release();
    expect(shown()).not.toContain('Other work');
    expect(shown()).toContain('Fixing tests');
    expect(host.querySelector('.hs-error')).toBeNull();
  });

  it('opens the session of a click that launched the app, taken once the page listens', async () => {
    native.clicks.push({ session: 'r2' });
    localStorage.setItem('agent-mcr.sessions.view', 'history');
    await act(async () => root.render(<App/>)); await flush(); await flush(); await frame();
    expect(shown()).toEqual(['Other work']);
    expect(harnessApi.ack).not.toHaveBeenCalled();
  });
});
