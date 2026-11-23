// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalPane from './TerminalPane';
import { harnessApi } from '../utils/harness';

type Link = { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: (e: MouseEvent, text: string) => void };
type Provider = { provideLinks: (y: number, done: (links: Link[] | undefined) => void) => void };

// A stand-in for xterm: the screen is the lines the test sets, one cell per column
type Marker = { line: number; disposed: boolean; dispose: () => void; onDispose: (f: () => void) => void };
type Decoration = { marker: Marker; x: number; width: number; options: Record<string, unknown>; element: HTMLElement; disposed: boolean };
const screen = vi.hoisted(() => ({
  lines: [] as string[][], wrapped: new Set<number>(), provider: null as unknown, focused: 0, providers: 0,
  decorations: [] as Decoration[], render: (() => {}) as (start: number, end: number) => void, switchBuffer: () => {},
  resized: [] as ((size: { cols: number; rows: number }) => void)[], cellReads: 0, alternate: false,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24; unicode = { activeVersion: '' };
    buffer = { active: { viewportY: 0, baseY: 0, cursorY: 0, get type() { return screen.alternate ? 'alternate' : 'normal'; }, getLine: (y: number) => {
      const cells = screen.lines[y];
      return cells && { length: cells.length, isWrapped: screen.wrapped.has(y), translateToString: () => cells.map(c => c || ' ').join(''),
        getCell: (x: number) => { screen.cellReads++; return { getChars: () => cells[x], getWidth: () => (cells[x] === '' && x > 0 && cells[x - 1].charCodeAt(0) > 0x2e80 ? 0 : 1) }; } };
    } }, onBufferChange: (f: () => void) => { screen.switchBuffer = f; return { dispose() {} }; } };
    onRender(f: (e: { start: number; end: number }) => void) { screen.render = (start, end) => f({ start, end }); return { dispose() {} }; }
    refresh() {}
    registerMarker(offset: number) {
      const done: (() => void)[] = [];
      const marker: Marker = { line: offset, disposed: false, dispose() { if (!marker.disposed) { marker.disposed = true; done.forEach(f => f()); } }, onDispose(f) { done.push(f); } };
      return marker;
    }
    registerDecoration(options: { marker: Marker; x: number; width: number }) {
      const element = document.createElement('div');
      element.className = 'xterm-decoration';
      const d: Decoration = { marker: options.marker, x: options.x, width: options.width, options, element, disposed: false };
      screen.decorations.push(d);
      return { onRender(f: (e: HTMLElement) => void) { f(element); }, dispose() { d.disposed = true; } };
    }
    loadAddon() {} open() {} write() {} paste() {} dispose() {}
    attachCustomKeyEventHandler() {}
    focus() { screen.focused++; }
    onKey() { return { dispose() {} }; } onData() { return { dispose() {} }; } onResize(f: (size: { cols: number; rows: number }) => void) { screen.resized.push(f); return { dispose() {} }; }
    registerLinkProvider(provider: unknown) { screen.provider = provider; screen.providers++; return { dispose() { screen.providers--; } }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { attach: vi.fn(() => new Promise(() => {})), detach: vi.fn(), resize: vi.fn(() => Promise.resolve()), input: vi.fn(), saveImage: vi.fn() } }));

/** A line as cells: a wide character takes two, the second one empty. */
const cells = (text: string) => [...text].flatMap(c => c.charCodeAt(0) > 0x2e80 ? [c, ''] : [c]);
const linksAt = (y: number) => { let got: Link[] | undefined; (screen.provider as Provider).provideLinks(y, links => { got = links; }); return got; };
const frame = async () => { await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(null))); }); };

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!('ResizeObserver' in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} disconnect() {} } });
  screen.lines = []; screen.wrapped = new Set(); screen.provider = null; screen.focused = 0; screen.providers = 0; screen.decorations = []; screen.resized = []; screen.cellReads = 0; screen.alternate = false;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('session pointers in a terminal', () => {
  const live = (id: string) => id === 'a27f56d8749b';

  it('links mcr:<id> of a known session at its columns, and the click names that session', async () => {
    const followed: string[] = [];
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live} onSession={id => followed.push(id)}/>));
    screen.lines = [cells('type this in mcr:a27f56d8749b now'), cells('日本 mcr:a27f56d8749b'), cells('plain text')];
    const first = linksAt(1)!;
    // Columns are 1-based and the end is the last cell of the link
    expect(first.map(l => [l.text, l.range.start, l.range.end])).toEqual([['mcr:a27f56d8749b', { x: 14, y: 1 }, { x: 29, y: 1 }]]);
    // Two wide characters before it: two columns more than characters
    expect(linksAt(2)!.map(l => [l.range.start.x, l.range.end.x])).toEqual([[6, 21]]);
    expect(linksAt(3)).toBeUndefined();
    expect(linksAt(9)).toBeUndefined();
    first[0].activate(new MouseEvent('click'), first[0].text);
    expect(followed).toEqual(['a27f56d8749b']);
  });

  it('links neither an unknown id nor a bare one, and nothing when the app names no sessions', async () => {
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live}/>));
    screen.lines = [cells('mcr:000000000000 and a27f56d8749b'), cells('mcr:a27f56d8749b')];
    expect(linksAt(1)).toBeUndefined();
    // Known, but nobody listens: the click is harmless
    linksAt(2)![0].activate(new MouseEvent('click'), '');
    await act(async () => root.render(<TerminalPane id="t1" active={false}/>));
    expect(linksAt(2)).toBeUndefined();
  });

  // The underlines standing now: row, first column, columns
  const underlined = () => screen.decorations.filter(d => !d.disposed).map(d => [d.marker.line, d.x, d.width]);

  it('underlines a pointer of a known session all the time, not only under the mouse (MCR-106)', async () => {
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live}/>));
    screen.lines = [cells('type this in mcr:a27f56d8749b now'), cells('日本 mcr:a27f56d8749b'), cells('mcr:000000000000 and a27f56d8749b'), cells('plain text')];
    screen.render(0, 3);
    expect(underlined()).toEqual([[0, 13, 16], [1, 5, 16]]);
    // A line over its cells and nothing else: no colour of its own, no text, and the mouse goes through it (the style sheet)
    for (const d of screen.decorations) {
      expect(d.element.classList.contains('hs-pointer')).toBe(true);
      expect(d.element.textContent).toBe('');
      expect(Object.keys(d.options).sort()).toEqual(['layer', 'marker', 'width', 'x']);
    }
    // Drawn again: nothing is added twice
    screen.render(0, 3);
    expect(underlined()).toHaveLength(2);
  });

  it('takes the underline away when the line is rewritten, the session ends, or the screen switches', async () => {
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live}/>));
    screen.lines = [cells('mcr:a27f56d8749b'), cells('see mcr:a27f56d8749b')];
    screen.render(0, 1);
    expect(underlined()).toEqual([[0, 0, 16], [1, 4, 16]]);
    // The agent redrew the first row with other text
    screen.lines[0] = cells('something else');
    screen.render(0, 0);
    expect(underlined()).toEqual([[1, 4, 16]]);
    // The session is no longer one the app knows: looked at again without waiting for a repaint
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={() => false}/>));
    expect(underlined()).toEqual([]);
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live}/>));
    expect(underlined()).toEqual([[1, 4, 16]]);
    // The other screen buffer starts clean, and is looked at in its turn
    screen.lines = [cells('plain')];
    screen.switchBuffer();
    expect(underlined()).toEqual([]);
  });

  it('treats a pointer cut by the line wrap as one: one link over both rows, underlined on each', async () => {
    const followed: string[] = [];
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live} onSession={id => followed.push(id)}/>));
    // A row of 20 columns full to its end, and the rest of the line on the next row
    screen.lines = [cells('see this: mcr:a27f56'), cells('d8749b and more'), cells('next line')];
    screen.wrapped = new Set([1]);
    for (const y of [1, 2]) {
      const links = linksAt(y)!;
      expect(links.map(l => [l.text, l.range.start, l.range.end])).toEqual([['mcr:a27f56d8749b', { x: 11, y: 1 }, { x: 6, y: 2 }]]);
    }
    expect(linksAt(3)).toBeUndefined();
    linksAt(2)![0].activate(new MouseEvent('click'), '');
    expect(followed).toEqual(['a27f56d8749b']);
    screen.render(1, 1);
    expect(underlined()).toEqual([[0, 10, 10], [1, 0, 6]]);
  });

  it('reads no line cell by cell that holds no pointer, also across a wrap', async () => {
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live}/>));
    screen.lines = [cells('plain output with nothing in it'), cells('more plain text, a hex a27f56d8749b'), cells('see: mc'), cells('r:a27f56d8749b')];
    screen.wrapped = new Set([3]);
    screen.render(0, 1);
    expect(linksAt(1)).toBeUndefined();
    expect(screen.cellReads).toBe(0);
    // A pointer cut by the wrap: "mcr:" is only in the joined text, and that line is read
    screen.render(2, 3);
    expect(screen.cellReads).toBeGreaterThan(0);
    expect(underlined()).toEqual([[2, 5, 2], [3, 0, 14]]);
  });

  it('makes no marks on the other screen buffer, where xterm shows none, and still links there', async () => {
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live}/>));
    screen.alternate = true;
    screen.lines = [cells('full screen: mcr:a27f56d8749b')];
    screen.render(0, 0);
    expect(underlined()).toEqual([]);
    expect(linksAt(1)!.map(l => l.text)).toEqual(['mcr:a27f56d8749b']);
  });

  it('drops every mark after a resize and marks the rows in view again', async () => {
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live}/>));
    screen.lines = [cells('see mcr:a27f56d8749b')];
    screen.render(0, 0);
    const before = screen.decorations.filter(d => !d.disposed);
    expect(before).toHaveLength(1);
    // The new width moved the pointer to another column
    screen.lines = [cells('  see mcr:a27f56d8749b')];
    screen.resized.forEach(f => f({ cols: 80, rows: 24 }));
    expect(before[0].disposed).toBe(true);
    expect(underlined()).toEqual([[0, 6, 16]]);
  });

  it('takes the keyboard when asked to, once per request, and gives its provider back', async () => {
    let served = 0;
    const pane = (focusAt?: number) => <TerminalPane id="t1" active={false} isSession={live} focusAt={focusAt} onFocused={() => { served++; }}/>;
    await act(async () => root.render(pane())); await frame();
    expect([screen.focused, served]).toEqual([0, 0]);
    await act(async () => root.render(pane(5))); await frame();
    expect([screen.focused, served]).toEqual([1, 1]);
    await act(async () => root.render(pane(5))); await frame();
    expect([screen.focused, served]).toEqual([1, 1]);
    await act(async () => root.render(pane(6))); await frame();
    expect([screen.focused, served]).toEqual([2, 2]);
    // The request taken back, as the app does once it is served: nothing more
    await act(async () => root.render(pane())); await frame();
    expect([screen.focused, served]).toEqual([2, 2]);
    expect(screen.providers).toBe(1);
    await act(async () => root.render(<div/>));
    expect(screen.providers).toBe(0);
  });
});

describe('a terminal is the view of one shown session (MCR-139)', () => {
  it('detaches its view and lets the terminal go when it is unmounted, and attaches anew, from the scrollback, when mounted again', async () => {
    let handle = 0;
    const streams: ((bytes: Uint8Array) => void)[] = [];
    vi.mocked(harnessApi.attach).mockImplementation((_id, onData) => { streams.push(onData); return Promise.resolve(++handle); });
    vi.mocked(harnessApi.detach).mockClear();
    await act(async () => root.render(<TerminalPane id="t1" active/>)); await frame();
    expect(vi.mocked(harnessApi.attach).mock.calls.map(c => c[0])).toEqual(['t1']);
    await act(async () => root.render(<div/>));
    // The runner stops streaming to it: nothing keeps parsing a session nobody sees
    expect(vi.mocked(harnessApi.detach).mock.calls).toEqual([[1]]);
    expect(host.querySelector('.hs-terminal')).toBeNull();
    // Shown again: a new view, which the runner starts with the scrollback it keeps
    await act(async () => root.render(<TerminalPane id="t1" active/>)); await frame();
    expect(vi.mocked(harnessApi.attach).mock.calls.map(c => c[0])).toEqual(['t1', 't1']);
    expect(streams).toHaveLength(2);
    vi.mocked(harnessApi.attach).mockImplementation(() => new Promise(() => {}));
  });
});
