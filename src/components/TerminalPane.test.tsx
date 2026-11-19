// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalPane from './TerminalPane';

type Link = { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: (e: MouseEvent, text: string) => void };
type Provider = { provideLinks: (y: number, done: (links: Link[] | undefined) => void) => void };

// A stand-in for xterm: the screen is the lines the test sets, one cell per column
const screen = vi.hoisted(() => ({ lines: [] as string[][], provider: null as unknown, focused: 0, providers: 0 }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24; unicode = { activeVersion: '' };
    buffer = { active: { getLine: (y: number) => {
      const cells = screen.lines[y];
      return cells && { length: cells.length, getCell: (x: number) => ({ getChars: () => cells[x], getWidth: () => (cells[x] === '' && x > 0 && cells[x - 1].charCodeAt(0) > 0x2e80 ? 0 : 1) }) };
    } } };
    loadAddon() {} open() {} write() {} paste() {} dispose() {}
    attachCustomKeyEventHandler() {}
    focus() { screen.focused++; }
    onKey() { return { dispose() {} }; } onData() { return { dispose() {} }; } onResize() { return { dispose() {} }; }
    registerLinkProvider(provider: unknown) { screen.provider = provider; screen.providers++; return { dispose() { screen.providers--; } }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { attach: vi.fn(() => new Promise(() => {})), detach: vi.fn(), resize: vi.fn(), input: vi.fn(), saveImage: vi.fn() } }));

/** A line as cells: a wide character takes two, the second one empty. */
const cells = (text: string) => [...text].flatMap(c => c.charCodeAt(0) > 0x2e80 ? [c, ''] : [c]);
const linksAt = (y: number) => { let got: Link[] | undefined; (screen.provider as Provider).provideLinks(y, links => { got = links; }); return got; };
const frame = async () => { await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(null))); }); };

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!('ResizeObserver' in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} disconnect() {} } });
  screen.lines = []; screen.provider = null; screen.focused = 0; screen.providers = 0;
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

  it('takes the keyboard when asked to, once per request, and gives its provider back', async () => {
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live}/>)); await frame();
    expect(screen.focused).toBe(0);
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live} focusAt={5}/>)); await frame();
    expect(screen.focused).toBe(1);
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live} focusAt={5}/>)); await frame();
    expect(screen.focused).toBe(1);
    await act(async () => root.render(<TerminalPane id="t1" active={false} isSession={live} focusAt={6}/>)); await frame();
    expect(screen.focused).toBe(2);
    expect(screen.providers).toBe(1);
    await act(async () => root.render(<div/>));
    expect(screen.providers).toBe(0);
  });
});
