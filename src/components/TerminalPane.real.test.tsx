// @vitest-environment happy-dom
// The pane on a real terminal (review 17086): xterm's own parser and write
// queue, from @xterm/headless, behind the few DOM methods the pane calls. The
// other pane tests use a synchronous stand-in, which hides what is queued.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal as Headless } from '@xterm/headless';
import LiveWorkspace from './LiveWorkspace';
import TerminalPane, { keep } from './TerminalPane';
import { harnessApi, type Hosted } from '../utils/harness';
import { MAX_KEPT } from '../utils/terminalKeep';

const made = vi.hoisted(() => ({ terms: [] as unknown[] }));
vi.mock('@xterm/xterm', async () => {
  const { Terminal: Real } = await import('@xterm/headless');
  class Terminal extends Real {
    element?: HTMLElement;
    textarea?: HTMLTextAreaElement;
    constructor(options: ConstructorParameters<typeof Real>[0]) { super({ ...options, allowProposedApi: true }); made.terms.push(this); }
    // A textarea that takes the keyboard, as xterm's does
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
vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: {
  attach: vi.fn(), detach: vi.fn(), resize: vi.fn(() => Promise.resolve()), input: vi.fn(), saveImage: vi.fn(),
  status: vi.fn(), listSince: vi.fn(), resumable: vi.fn(),
} }));
vi.mock('../utils/tauri', async importOriginal => ({ ...await importOriginal<object>(), isTauri: () => true }));

type On = { start: (from: number | null) => void; data: (bytes: Uint8Array) => void };
let views: { id: string; since: number | null; on: On }[] = [];
let root: Root; let host: HTMLDivElement;
const bytes = (text: string) => new TextEncoder().encode(text);
const frame = async () => { await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(null))); }); };
/** Every write queued so far parsed, and the pane's callbacks run */
const parsed = async () => { await act(async () => { await Promise.all((made.terms as Headless[]).map(t => new Promise<void>(resolve => t.write('', resolve)))); await new Promise(r => setTimeout(r, 0)); }); };
const show = async (id: string) => { await act(async () => root.render(<TerminalPane id={id} active focusOnMount/>)); await frame(); };
const hide = async () => { await act(async () => root.render(<div/>)); };
const lines = (t: Headless) => { const b = t.buffer.active; const out: string[] = []; for (let y = 0; y < b.length; y++) { const l = b.getLine(y)?.translateToString(true) ?? ''; if (l) out.push(l); } return out; };
const last = () => made.terms[made.terms.length - 1] as Headless;
/** The replacement must accept the first replay without another attach. */
const answer = async (text: string, from: number | null) => {
  const count = views.length;
  const { on } = views[count - 1];
  await act(async () => { on.start(from); on.data(bytes(text)); });
  await frame();
  expect(views).toHaveLength(count);
  await parsed();
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!('ResizeObserver' in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} disconnect() {} } });
  keep.protect(new Set()); keep.retain(new Set()); made.terms = []; views = [];
  vi.mocked(harnessApi.input).mockReset().mockResolvedValue(undefined);
  let handle = 0;
  vi.mocked(harnessApi.attach).mockImplementation((id, since, on) => { views.push({ id, since, on }); return Promise.resolve(++handle); });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Enter in a visible terminal with no attached input stream', () => {
  it('reaches the session during attach', async () => {
    let attached!: (handle: number) => void;
    vi.mocked(harnessApi.attach).mockImplementationOnce(() => new Promise(resolve => { attached = resolve; }));
    await show('opening');
    await act(async () => { last().input('\r', true); });
    expect(harnessApi.input).not.toHaveBeenCalled();
    await act(async () => { attached(17); });
    expect(harnessApi.input).toHaveBeenCalledExactlyOnceWith(17, '\r');
  });

  it('drops Down Down Enter while attaching and sends the next Enter', async () => {
    let attached!: (handle: number) => void;
    vi.mocked(harnessApi.attach).mockImplementationOnce(() => new Promise(resolve => { attached = resolve; }));
    await show('opening');
    await act(async () => {
      last().input('\x1b[B', true);
      last().input('\x1b[B', true);
      last().input('\r', true);
    });
    await act(async () => { attached(17); });
    expect(harnessApi.input).not.toHaveBeenCalled();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Terminal input was dropped');
    await act(async () => { last().input('\r', true); });
    expect(harnessApi.input).toHaveBeenCalledExactlyOnceWith(17, '\r');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('reaches the session when the input stream was detached', async () => {
    await show('detached');
    vi.mocked(harnessApi.input).mockRejectedValueOnce('The terminal is detached');
    await act(async () => { last().input('\r', true); });
    expect(views.map(view => view.id)).toEqual(['detached', 'detached']);
    expect(vi.mocked(harnessApi.input).mock.calls).toEqual([[1, '\r'], [2, '\r']]);
  });

  it('drops Enter after a failed key and sends the retyped sequence', async () => {
    await show('detached');
    let lost!: (error: string) => void;
    vi.mocked(harnessApi.input).mockImplementationOnce(() => new Promise((_, reject) => { lost = reject; }));
    await act(async () => {
      last().input('\x1b[B', true);
      last().input('\r', true);
    });
    await act(async () => { lost('The terminal is detached'); });
    expect(vi.mocked(harnessApi.input).mock.calls).toEqual([[1, '\x1b[B']]);
    await act(async () => {
      last().input('\x1b[B', true);
      last().input('\r', true);
    });
    expect(vi.mocked(harnessApi.input).mock.calls).toEqual([[1, '\x1b[B'], [2, '\x1b[B'], [2, '\r']]);
  });

  it('guards the replacement Enter when reconnect drops a queued key', async () => {
    await show('detached');
    let lost!: (error: string) => void;
    vi.mocked(harnessApi.input).mockImplementationOnce(() => new Promise((_, reject) => { lost = reject; }));
    await act(async () => {
      last().input('\r', true);
      last().input('\x1b[B', true);
    });
    await act(async () => { lost('The terminal is detached'); });
    expect(views.map(view => view.id)).toEqual(['detached', 'detached']);
    await act(async () => { last().input('\r', true); });
    expect(vi.mocked(harnessApi.input).mock.calls).toEqual([[1, '\r']]);
    await act(async () => { last().input('\r', true); });
    expect(vi.mocked(harnessApi.input).mock.calls).toEqual([[1, '\r'], [2, '\r']]);
  });

  it('retries Enter when the preceding key reached the session', async () => {
    await show('detached');
    vi.mocked(harnessApi.input).mockResolvedValueOnce(undefined).mockRejectedValueOnce('The terminal is detached');
    await act(async () => {
      last().input('\x1b[B', true);
      last().input('\r', true);
    });
    expect(vi.mocked(harnessApi.input).mock.calls).toEqual([[1, '\x1b[B'], [1, '\r'], [2, '\r']]);
  });

  it('does not keep retrying Enter if the replacement stream is detached', async () => {
    await show('detached');
    vi.mocked(harnessApi.input).mockRejectedValue('The terminal is detached');
    await act(async () => { last().input('\r', true); });
    expect(vi.mocked(harnessApi.input).mock.calls).toEqual([[1, '\r'], [2, '\r']]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('The terminal is detached');
  });

  it('drops a pending Enter when the pane is hidden before it attaches', async () => {
    let attached!: (handle: number) => void;
    vi.mocked(harnessApi.attach).mockImplementationOnce(() => new Promise(resolve => { attached = resolve; }));
    await show('opening');
    await act(async () => { last().input('\r', true); });
    await hide();
    await act(async () => { attached(17); });
    expect(harnessApi.detach).toHaveBeenCalledWith(17);
    expect(harnessApi.input).not.toHaveBeenCalled();
  });

  it('cancels writes still queued when the pane detaches on hide', async () => {
    await show('hidden');
    let written!: () => void;
    vi.mocked(harnessApi.input).mockImplementationOnce(() => new Promise(resolve => { written = resolve; }));
    await act(async () => {
      last().input('a', true);
      last().input('b', true);
      last().input('\r', true);
    });
    await hide();
    await act(async () => { written(); });
    expect(harnessApi.input).toHaveBeenCalledExactlyOnceWith(1, 'a');
    expect(harnessApi.detach).toHaveBeenCalledWith(1);
  });
});

it('keeps the selected terminal focused when a different pane mounts', async () => {
  const panes = (second: boolean) => <><TerminalPane id="selected" active focusOnMount/>{second && <TerminalPane id="another" active/>}</>;
  await act(async () => root.render(panes(false)));
  await frame();
  const selected = host.querySelector('textarea');
  expect(document.activeElement).toBe(selected);
  await act(async () => root.render(panes(true)));
  await frame();
  expect(host.querySelectorAll('textarea')).toHaveLength(2);
  expect(document.activeElement).toBe(selected);
});

it('detaches zero-height and clipped panes, drops late frames, and reuses the xterm', async () => {
  const session: Hosted = { id: 'geometry', pid: 7, argv: [], cwd: '/work/repo', started: 1, cols: 80, rows: 24,
    title: 'Geometry test', lastOutput: 1, exit: null, meta: {} };
  vi.mocked(harnessApi.status).mockResolvedValue({ runner: { protocol: 1, pid: 8, version: 'test', exe: '/x' }, profiles: [], home: '/work' });
  vi.mocked(harnessApi.listSince).mockResolvedValue({ stamp: 'geometry', sessions: [session] });
  vi.mocked(harnessApi.resumable).mockResolvedValue([]);
  vi.mocked(harnessApi.detach).mockClear();
  const rect = (height: number) => new DOMRect(0, 0, 640, height);
  let resize = (_height: number) => {};
  let intersect = (_height: number) => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: (entries: Partial<ResizeObserverEntry>[]) => void) {}
    observe(el: Element) { if (el.classList.contains('hs-pane-slot')) resize = height => this.callback([{ contentRect: rect(height) }]); }
    disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
    observe() { intersect = height => this.callback([{ isIntersecting: true, intersectionRect: rect(height) }]); }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
  await act(async () => root.render(<LiveWorkspace active recentDirectories={[]}/>));
  await act(async () => host.querySelector<HTMLButtonElement>('button.hs-item')!.click());
  await act(async () => { resize(0); intersect(0); });
  expect(views).toHaveLength(0);
  await act(async () => { resize(400); intersect(400); });
  expect(views).toHaveLength(1);
  const term = last();
  const shown = bytes('shown\r\n');
  const background = bytes('background\r\n');
  await act(async () => { views[0].on.start(0); views[0].on.data(shown); });
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); resize(0); intersect(0); views[0].on.data(background); });
  await parsed();
  expect(lines(term)).toEqual(['shown', 'background']);
  expect(harnessApi.detach).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); resize(400); intersect(400); });
  expect(views).toHaveLength(1);

  await act(async () => intersect(0));
  expect(vi.mocked(harnessApi.detach).mock.calls).toEqual([[1]]);
  expect(keep.ids).toContain(session.id);
  const write = vi.spyOn(term, 'write');
  act(() => views[0].on.data(bytes('late clipped frame\r\n')));
  expect(write).not.toHaveBeenCalled();

  await act(async () => intersect(400));
  expect(views).toHaveLength(2);
  const offset = shown.length + background.length;
  expect(views[1].since).toBe(offset);
  expect(made.terms).toEqual([term]);
  await act(async () => { views[1].on.start(offset); views[1].on.data(bytes('resumed\r\n')); });
  await parsed();
  expect(lines(term)).toEqual(['shown', 'background', 'resumed']);

  await act(async () => resize(0));
  expect(vi.mocked(harnessApi.detach).mock.calls).toEqual([[1], [2]]);
  write.mockClear();
  act(() => views[1].on.data(bytes('late zero-height frame\r\n')));
  expect(write).not.toHaveBeenCalled();
});

describe('a pane on a real terminal (review 17086)', () => {
  it('brings a terminal pushed out of the keep back from the runner replay, whole, also when its last frame ended inside an escape sequence', async () => {
    await show('a');
    // The last frame stops in the middle of a colour sequence; the rest is still on its way when the pane is let go
    act(() => { views[0].on.start(0); views[0].on.data(bytes('hello \x1b[3')); });
    await hide();
    for (const id of ['b', 'c', 'd', 'e'].slice(0, MAX_KEPT)) { await show(id); await hide(); await parsed(); }
    await parsed();
    // Shown again; the runner answers whatever it is asked, as the real one does: from the offset, or all it holds
    await show('a');
    const asked = views[views.length - 1];
    const all = bytes('hello \x1b[31mred\x1b[0m\r\n');
    act(() => {
      const from = asked.since !== null && asked.since <= all.length ? asked.since : 0;
      asked.on.start(from); asked.on.data(all.slice(from));
    });
    await parsed();
    // Not "hello 1mred": the colour sequence is read whole, and nothing is shown twice
    expect(lines(last())).toEqual(['hello red']);
    expect(asked.since).toBeNull();
  });

  it('leaves none of a pushed-out terminal\'s contents before the replay when the runner cannot go on', async () => {
    await show('a');
    act(() => { views[0].on.start(0); views[0].on.data(bytes('old line\r\n')); });
    await hide(); await parsed();
    for (const id of ['b', 'c', 'd', 'e'].slice(0, MAX_KEPT)) { await show(id); await hide(); await parsed(); }
    await show('a');
    const asked = views[views.length - 1];
    // The runner holds nothing from where 'a' was: it starts its scrollback further on
    act(() => { asked.on.start(5_000_000); asked.on.data(bytes('new line\r\n')); });
    await parsed();
    expect(lines(last())).toEqual(['new line']);
  });

  it('leaves no older byte when the runner cannot go on from where a kept terminal was', async () => {
    await show('a');
    act(() => { views[0].on.start(0); views[0].on.data(bytes('old line\r\n')); });
    await hide();
    await parsed();
    await show('a');
    expect(views[views.length - 1].since).toBe(10);
    // The runner holds nothing from offset 10: it starts its scrollback further on
    await answer('new line\r\n', 5_000_000);
    expect(lines(last())).toEqual(['new line']);
  });

  it('lets Enter through when a key in flight succeeds during replay replacement', async () => {
    await show('a');
    act(() => { views[0].on.start(0); views[0].on.data(bytes('old line\r\n')); });
    await hide();
    await parsed();
    await show('a');
    let written!: () => void;
    vi.mocked(harnessApi.input).mockImplementationOnce(() => new Promise(resolve => { written = resolve; }));
    await act(async () => { last().input('a', true); });
    const kept = last();
    await act(async () => { views[1].on.start(5_000_000); });
    expect(last()).toBe(kept);
    await act(async () => { written(); });
    expect(last()).not.toBe(kept);
    await act(async () => { last().input('\r', true); });
    expect(vi.mocked(harnessApi.input).mock.calls).toEqual([[2, 'a'], [2, '\r']]);
  });

  it('shows a replay whole after a kept terminal stopped inside an escape sequence (review 17088)', async () => {
    await show('a');
    // The last bytes the pane had leave xterm's parser inside a colour sequence
    act(() => { views[0].on.start(0); views[0].on.data(bytes('x\x1b[3')); });
    await hide();
    await parsed();
    await show('a');
    // The runner can no longer go on from there: what it holds starts further on
    await answer('new line\r\n', 5_000_000);
    // Not "ew line": no unfinished sequence of the old terminal eats the replay's first bytes
    expect(lines(last())).toEqual(['new line']);
  });

  it('hands a legacy replay without an offset to a fresh terminal on the same view', async () => {
    await show('a');
    act(() => { views[0].on.start(null); views[0].on.data(bytes('old line\r\n')); });
    await hide(); await parsed();
    await show('a');
    await answer('old line\r\nnew line\r\n', null);
    expect(lines(last())).toEqual(['old line', 'new line']);
  });

  it('detaches a transferred view if the pane closes before using its replay', async () => {
    await show('a');
    act(() => { views[0].on.start(0); views[0].on.data(bytes('old line\r\n')); });
    await hide(); await parsed();
    await show('a');
    vi.mocked(harnessApi.detach).mockClear();
    await act(async () => {
      views[1].on.start(5_000_000);
      root.render(<div/>);
      views[1].on.data(bytes('on its way\r\n'));
    });
    expect(views).toHaveLength(2);
    expect(vi.mocked(harnessApi.detach).mock.calls).toEqual([[2]]);
  });

  it('gives the keyboard to the new terminal when it replaces one that had it (review 17090)', async () => {
    await show('a');
    act(() => { views[0].on.start(0); views[0].on.data(bytes('old line\r\n')); });
    await hide();
    await parsed();
    await show('a');
    // Shown again, the kept terminal has the keyboard
    const kept = last();
    expect(document.activeElement).toBe((kept as unknown as { textarea: HTMLElement }).textarea);
    // The runner cannot go on from its offset: a new terminal replaces it, and the person can type on
    await answer('new line\r\n', 5_000_000);
    await frame();
    const now = last();
    expect(now).not.toBe(kept);
    expect(document.activeElement).toBe((now as unknown as { textarea: HTMLElement }).textarea);
  });

  it('does not keep the terminal of a session that left the list while its last bytes were being parsed (review 17088)', async () => {
    // Its own session id: the keep remembers for good which sessions left the list
    keep.retain(new Set(['left']));
    await show('left');
    // Enough output that xterm is still parsing it, in slices, when the pane is let go
    const lots = bytes('queued line of an agent at work\r\n'.repeat(60_000));
    act(() => { views[0].on.start(0); views[0].on.data(lots); });
    // Hidden with its bytes still queued; the list lets the session go before xterm has parsed them
    await act(async () => { root.render(<div/>); });
    keep.retain(new Set());
    await parsed();
    expect(keep.ids).toEqual([]);
  });

  it('shows every line once when it is shown again before what it had was parsed', async () => {
    await show('a');
    const term = last();
    const queued = bytes('\x1b[?2004hone\r\ntwo\r\n');
    act(() => { views[0].on.start(0); views[0].on.data(queued); });
    // Hidden and shown again at once: the first terminal's bytes are still queued
    await hide();
    await show('a');
    const asked = views[views.length - 1];
    expect(asked.since).toBe(queued.length);
    expect(last()).toBe(term);
    act(() => { asked.on.start(queued.length); asked.on.data(bytes('three\r\n')); });
    await parsed();
    expect(lines(last())).toEqual(['one', 'two', 'three']);
    expect(term.modes.bracketedPasteMode).toBe(true);
    // The first terminal is not kept beside the one shown
    await hide(); await parsed();
    expect(keep.ids).toEqual(['a']);
  });
});

describe('a view a clicked banner shows (MCR-180)', () => {
  // The browser xterm answers DECSET 1004 at once with the focus it has (CoreBrowserTerminal's
  // _reportFocus): ESC [ O for a view without the keyboard. The headless one parses the mode
  // and leaves the report to the browser, so the report goes in through the same onData here
  const reportFocus = (focused: boolean) => { const t = last(); if (t.modes.sendFocusMode) t.input(focused ? '\x1b[I' : '\x1b[O', false); };

  it('sends no focus report, nor any other answer, until the operator gives it the keyboard', async () => {
    const onActive = vi.fn();
    await act(async () => root.render(<TerminalPane id="shown" active passive onActive={onActive}/>)); await frame();
    await answer('\x1b[?1004hthe agent turns on focus reports\r\n', 0);
    expect(last().modes.sendFocusMode).toBe(true);
    await act(async () => { reportFocus(false); });
    await act(async () => { last().input('\x1b[1;1R', false); });
    expect(harnessApi.input).not.toHaveBeenCalled();
    expect(onActive).not.toHaveBeenCalled();
    // The operator clicks into it: the view is theirs, and its focus report goes out
    await act(async () => { host.querySelector('textarea')!.dispatchEvent(new FocusEvent('focus')); reportFocus(true); });
    expect(onActive).toHaveBeenCalledOnce();
    expect(vi.mocked(harnessApi.input).mock.calls).toEqual([[1, '\x1b[I']]);
  });

  it('a view the operator chose sends its focus report as before', async () => {
    await act(async () => root.render(<TerminalPane id="chosen" active/>)); await frame();
    await answer('\x1b[?1004h', 0);
    await act(async () => { reportFocus(false); });
    expect(vi.mocked(harnessApi.input).mock.calls).toEqual([[1, '\x1b[O']]);
  });
});
