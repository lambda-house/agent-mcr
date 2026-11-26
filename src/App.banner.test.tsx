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
import { buildMenu, menuCommands } from './utils/commands';
import { useStore } from './store';

const native = vi.hoisted(() => ({ clicks: [] as unknown[], listeners: new Map<string, () => void>() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => command === 'harness_open_session_take' ? native.clicks.shift() ?? null : null),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: () => void) => { native.listeners.set(name, handler); return () => native.listeners.delete(name); }) }));
const made = vi.hoisted(() => ({ terms: [] as unknown[], focuses: 0 }));
vi.mock('@xterm/xterm', async () => {
  const { Terminal: Real } = await import('@xterm/headless');
  class Terminal extends Real {
    element?: HTMLElement;
    textarea?: HTMLTextAreaElement;
    constructor(options: ConstructorParameters<typeof Real>[0]) { super({ ...options, allowProposedApi: true }); made.terms.push(this); }
    open(parent: HTMLElement) { this.element = document.createElement('div'); this.textarea = document.createElement('textarea'); this.element.appendChild(this.textarea); parent.appendChild(this.element); }
    // Real xterm fires onKey before onData for a key the person pressed (_keyDown, _keyPress)
    private keys: ((e: { key: string; domEvent: KeyboardEvent }) => void)[] = [];
    onKey(listener: (e: { key: string; domEvent: KeyboardEvent }) => void) { this.keys.push(listener); return { dispose: () => { this.keys = this.keys.filter(l => l !== listener); } }; }
    input(data: string, wasUserInput = true) { if (wasUserInput) this.keys.forEach(l => l({ key: data, domEvent: new KeyboardEvent('keydown') })); super.input(data, wasUserInput); }
    registerLinkProvider() { return { dispose() {} }; }
    registerDecoration() { return undefined; }
    onRender() { return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    focus() { made.focuses++; this.textarea?.focus(); }
    refresh() {}
    selected = '';
    hasSelection() { return !!this.selected; }
    getSelection() { return this.selected; }
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} fit() {} dispose() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('./utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: {
  copyAsTask: vi.fn(), status: vi.fn(), list: vi.fn(), listSince: vi.fn(), resumable: vi.fn(), ack: vi.fn(), background: vi.fn(),
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
/** What the next list reads say of a click the app holds for the page */
let bannerPending: boolean;
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
/** A click as the app's slot hands it to the page: its session and its native stamp */
let stamps = 0;
const click = (session: string | null) => ({ session, at: ++stamps });
const banner = async (session: string | null) => { native.clicks.push(click(session)); await act(async () => native.listeners.get('harness-open-session')!()); await flush(); };
const sessionsButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.workspace-switch-option')].find(b => b.textContent?.includes(label))!;
const row = (title: string) => [...host.querySelectorAll<HTMLButtonElement>('button.hs-item')].find(b => b.textContent?.includes(title))!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  localStorage.setItem('agent-mcr.sessions.view', 'live');
  keep.protect(new Set()); keep.retain(new Set());
  native.clicks = []; native.listeners.clear(); made.terms = []; made.focuses = 0; views = []; held = null; bannerPending = false;
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
    return { stamp: now, sessions: now === stamp ? null : listed, ...(bannerPending ? { bannerPending: true } : {}) };
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
  const t1 = await r1Selected();
  await act(async () => sessionsButton('Documents').click()); await flush();
  expect(host.querySelector('[data-toolbar]')).not.toBeNull();
  return t1;
}

/** r1 as above, its done mark standing, and Live still shown; the window has the focus now */
async function r1Selected() {
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  await act(async () => root.render(<App/>)); await flush(); await flush();
  await act(async () => row('Fixing tests').click()); await flush(); await frame();
  const t1 = termOf('Fixing tests');
  await output('r1', t1, '\x1b[?1004hworking\r\n');
  expect(t1.modes.sendFocusMode).toBe(true);
  t1.textarea.blur();
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
    native.clicks.push(click('r2'));
    localStorage.setItem('agent-mcr.sessions.view', 'history');
    await act(async () => root.render(<App/>)); await flush(); await flush(); await frame();
    expect(shown()).toEqual(['Other work']);
    expect(harnessApi.ack).not.toHaveBeenCalled();
  });
});

describe('the three ways round 4 still let a banner act for the operator (review 17369)', () => {
  it('keeps the session selected before unacknowledged when the banner\'s session has ended (17369 #1)', async () => {
    await r1SelectedThenDocuments();
    const release = holdReads();
    await banner('r2');
    listed = [done(running, 5), { ...other, exit: { code: 0, signal: null, at: 9 } }];
    await release();
    expect(host.querySelector('.hs-error')?.textContent).toContain('no longer running');
    expect(shown()).toContain('Fixing tests');
    await flush();
    expect(harnessApi.ack).not.toHaveBeenCalled();
    // The operator's own row click: as before
    await act(async () => row('Fixing tests').click()); await flush();
    expect(harnessApi.ack).toHaveBeenCalledWith('r1', 5);
  });

  it('does not refocus a terminal that reconnects while the ask is pending (17369 #2)', async () => {
    await r1Selected();
    const t1 = termOf('Fixing tests');
    // The operator types in r1; that key is still on its way when the banner comes
    let fail!: (e: Error) => void;
    vi.mocked(harnessApi.input).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    await act(async () => { t1.textarea.focus(); t1.input('a', true); });
    const release = holdReads();
    await banner('r2');
    const before = made.focuses;
    await act(async () => fail(new Error('The terminal is detached'))); await flush(); await frame(); await frame();
    expect(made.focuses).toBe(before);
    await release();
  });

  it('does not send a focus report that was queued behind a key while the ask is pending (17369 #2)', async () => {
    await r1Selected();
    const t1 = termOf('Fixing tests');
    let sent!: () => void;
    vi.mocked(harnessApi.input).mockImplementationOnce(() => new Promise<void>(resolve => { sent = resolve; }));
    await act(async () => { t1.input('a', true); report(t1, true); });
    const release = holdReads();
    await banner('r2');
    await act(async () => sent()); await flush();
    expect(vi.mocked(harnessApi.input).mock.calls.map(c => c[1])).toEqual(['a']);
    await release();
  });

  it('opens nothing when the click about no session is taken after the list read came back (17369 #3)', async () => {
    await r1SelectedThenDocuments();
    const release = holdReads();
    await banner('r2');
    // The state file's banner: the page hears of it, its take is on its way
    let taken!: (click: unknown) => void;
    const late = click(null);
    native.clicks.push(new Promise(resolve => { taken = resolve; }));
    await act(async () => native.listeners.get('harness-open-session')!()); await flush();
    await release();
    await act(async () => taken(late)); await flush(); await frame();
    expect(shown()).not.toContain('Other work');
    expect(shown()).toContain('Fixing tests');
  });

  it('opens nothing when the list read that decides the ask says a newer click is waiting (17369 #3)', async () => {
    await r1SelectedThenDocuments();
    const release = holdReads();
    await banner('r2');
    // The service handed the list read a click about no session; the page has not heard of it yet
    native.clicks.push(click(null));
    bannerPending = true;
    await release();
    expect(shown()).not.toContain('Other work');
    expect(useBannerIntent.getState().intent).toBeNull();
  });
});

describe('the four ways round 5 still let a banner act for the operator, or lost their keys (review 17375)', () => {
  const ended2 = (since: number): Hosted => done({ ...other, exit: { code: 0, signal: null, at: 9 } }, since);

  it('cancels the ask before an explicit Mark report as seen acknowledges, so no ack leaves while it is pending (17375 #1)', async () => {
    listed = [running, ended2(6)];
    await r1SelectedThenDocuments();
    const intentAtAck: unknown[] = [];
    vi.mocked(harnessApi.ack).mockImplementation(async () => { intentAtAck.push(useBannerIntent.getState().intent); });
    const release = holdReads();
    await banner('r1');
    expect(useBannerIntent.getState().intent?.id).toBe('r1');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Actions for Other work"]')!.click());
    const seen = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.includes('Mark report as seen'))!;
    await act(async () => seen.click()); await flush();
    expect(vi.mocked(harnessApi.ack).mock.calls).toEqual([['r2', 6]]);
    expect(intentAtAck).toEqual([null]);
    await release();
  });

  it('does not give the old terminal the keyboard back when Copy as task closes while the ask is pending (17375 #2)', async () => {
    const t1 = await r1Selected();
    await act(async () => { t1.textarea.focus(); });
    (t1 as unknown as { selected: string }).selected = 'the agent said this';
    // Edit → Copy Terminal Selection as Task…: the app menu's command, run as the menu runs it
    const command = menuCommands(buildMenu({ reopenClosedTab: () => {} })).find(c => c.id === 'edit.copyAsTask')!;
    expect(command.enabled?.(useStore.getState())).toBe(true);
    await act(async () => command.run());
    expect(document.activeElement).not.toBe(t1.textarea);
    const dialog = document.querySelector<HTMLElement>('.tc-dialog')!;
    expect(dialog).not.toBeNull();
    const release = holdReads();
    await banner('r2');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await flush();
    expect(document.querySelector('.tc-dialog')).toBeNull();
    expect(document.activeElement).not.toBe(t1.textarea);
    expect(harnessApi.input).not.toHaveBeenCalled();
    await release();
  });

  it('does not let an older click, taken late, undo a newer click about no session (17375 #3)', async () => {
    await r1SelectedThenDocuments();
    const release = holdReads();
    await banner('r2');
    // A second click about r2, with r2 still pending: its take is on its way
    const older = click('r2');
    let reply!: (c: unknown) => void;
    native.clicks.push(new Promise(resolve => { reply = resolve; }));
    await act(async () => native.listeners.get('harness-open-session')!()); await flush();
    // A later click about no session, taken at once
    await banner(null);
    expect(useBannerIntent.getState().intent).toBeNull();
    // Then the older reply arrives: it is older than the click that took the ask back
    await act(async () => reply(older)); await flush();
    expect(useBannerIntent.getState().intent).toBeNull();
    // The fresh list opens nothing
    await release(); await flush();
    expect(shown()).not.toContain('Other work');
  });

  it('says that keys queued behind a write were dropped, and does not submit the partial line (17375 #4)', async () => {
    const t1 = await r1Selected();
    let written!: () => void;
    vi.mocked(harnessApi.input).mockImplementationOnce(() => new Promise<void>(resolve => { written = resolve; }));
    // The operator types "ab": "a" is on its way, "b" waits behind it
    await act(async () => { t1.input('a', true); t1.input('b', true); });
    const release = holdReads();
    await banner('r2');
    await act(async () => written()); await flush();
    expect(vi.mocked(harnessApi.input).mock.calls.map(c => c[1])).toEqual(['a']);
    expect(host.textContent).toContain('Terminal input was dropped');
    // A click about no session takes the ask back; the operator presses Enter in r1
    await banner(null);
    await act(async () => { t1.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); t1.input('\r', true); }); await flush();
    expect(vi.mocked(harnessApi.input).mock.calls.map(c => c[1])).toEqual(['a']);
    // They looked at the prompt, retyped and pressed Enter again: that one goes out
    await act(async () => { t1.input('b', true); t1.input('\r', true); }); await flush();
    expect(vi.mocked(harnessApi.input).mock.calls.map(c => c[1])).toEqual(['a', 'b', '\r']);
    await release();
  });
});
