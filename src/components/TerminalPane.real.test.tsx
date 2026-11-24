// @vitest-environment happy-dom
// The pane on a real terminal (review 17086): xterm's own parser and write
// queue, from @xterm/headless, behind the few DOM methods the pane calls. The
// other pane tests use a synchronous stand-in, which hides what is queued.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal as Headless } from '@xterm/headless';
import TerminalPane, { keep } from './TerminalPane';
import { harnessApi } from '../utils/harness';
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
vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { attach: vi.fn(), detach: vi.fn(), resize: vi.fn(() => Promise.resolve()), input: vi.fn(), saveImage: vi.fn() } }));

type On = { start: (from: number | null) => void; data: (bytes: Uint8Array) => void };
let views: { id: string; since: number | null; on: On }[] = [];
let root: Root; let host: HTMLDivElement;
const bytes = (text: string) => new TextEncoder().encode(text);
const frame = async () => { await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(null))); }); };
/** Every write queued so far parsed, and the pane's callbacks run */
const parsed = async () => { await act(async () => { await Promise.all((made.terms as Headless[]).map(t => new Promise<void>(resolve => t.write('', resolve)))); await new Promise(r => setTimeout(r, 0)); }); };
const show = async (id: string) => { await act(async () => root.render(<TerminalPane id={id} active/>)); await frame(); };
const hide = async () => { await act(async () => root.render(<div/>)); };
const lines = (t: Headless) => { const b = t.buffer.active; const out: string[] = []; for (let y = 0; y < b.length; y++) { const l = b.getLine(y)?.translateToString(true) ?? ''; if (l) out.push(l); } return out; };
const last = () => made.terms[made.terms.length - 1] as Headless;
/**
 * The runner's answer to the pane's latest view: it starts at `from` and sends
 * `text`. A pane that lets its terminal go on that answer opens a new view,
 * which the runner answers the same way.
 */
const answer = async (text: string, from: number) => {
  const first = views[views.length - 1];
  await act(async () => { first.on.start(from); first.on.data(bytes(text)); });
  await frame();
  const now = views[views.length - 1];
  if (now !== first) await act(async () => { now.on.start(from); now.on.data(bytes(text)); });
  await parsed();
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!('ResizeObserver' in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} disconnect() {} } });
  keep.retain(new Set()); made.terms = []; views = [];
  let handle = 0;
  vi.mocked(harnessApi.attach).mockImplementation((id, since, on) => { views.push({ id, since, on }); return Promise.resolve(++handle); });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

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
    act(() => { views[0].on.start(0); views[0].on.data(bytes('one\r\ntwo\r\n')); });
    // Hidden and shown again at once: the first terminal's bytes are still queued
    await hide();
    await show('a');
    const asked = views[views.length - 1];
    act(() => { asked.on.start(asked.since ?? 0); if (asked.since === null) asked.on.data(bytes('one\r\ntwo\r\n')); asked.on.data(bytes('three\r\n')); });
    await parsed();
    expect(lines(last())).toEqual(['one', 'two', 'three']);
    // The first terminal is not kept beside the one shown
    await hide(); await parsed();
    expect(keep.ids).toEqual(['a']);
  });
});
