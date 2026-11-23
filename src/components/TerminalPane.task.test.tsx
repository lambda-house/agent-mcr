// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TerminalPane, { keep } from './TerminalPane';
import { harnessApi } from '../utils/harness';
import { terminalTask } from '../utils/terminalTask';

// xterm needs a canvas and a layout: a stand-in with what the pane uses, whose selection the test sets
const fake = { selection: '' };
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24; unicode = { activeVersion: '' }; textarea: HTMLTextAreaElement | undefined;
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, cursorY: 0, getLine: () => undefined }, onBufferChange: () => ({ dispose() {} }) };
    loadAddon() {}
    open(el: HTMLElement) { this.textarea = document.createElement('textarea'); el.appendChild(this.textarea); }
    attachCustomKeyEventHandler() {}
    registerLinkProvider() { return { dispose() {} }; }
    onRender() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    onKey() { return { dispose() {} }; }
    onData() { return { dispose() {} }; }
    hasSelection() { return !!fake.selection; }
    getSelection() { return fake.selection; }
    dispose() {} focus() {} write() {} paste() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: {
  attach: vi.fn(() => new Promise(() => {})), detach: vi.fn(), resize: vi.fn(() => Promise.resolve()), input: vi.fn(() => Promise.resolve()),
  copyText: vi.fn(() => Promise.resolve()), copyAsTask: vi.fn(() => Promise.resolve()),
} }));

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  // Each test starts with no kept terminal (MCR-139)
  keep.retain(new Set());
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!('ResizeObserver' in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} disconnect() {} } });
  fake.selection = '';
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.copyText).mockClear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; terminalTask.current = null; });

const show = (active = true) => act(() => root.render(<TerminalPane id="ab12cd34ef56" name="Gap finder" active={active}/>));
const rightClick = () => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
  act(() => { host.querySelector('.hs-terminal')!.dispatchEvent(event); });
  return event;
};
const item = (label: string) => [...document.querySelectorAll('.tc-menu button')].find(b => b.textContent === label) as HTMLButtonElement;

it('offers Copy and Copy as task on a right click only when text is selected', async () => {
  show();
  // No selection: the right click is xterm's, as before
  expect(rightClick().defaultPrevented).toBe(false);
  expect(document.querySelector('.tc-menu')).toBeNull();
  fake.selection = '⏺ Gap 3: no drill-down';
  expect(rightClick().defaultPrevented).toBe(true);
  expect([...document.querySelectorAll('.tc-menu button')].map(b => b.textContent)).toEqual(['Copy', 'Copy as task…']);
  // Copy goes through the app's clipboard tool, not the webview's
  act(() => item('Copy').click());
  expect(harnessApi.copyText).toHaveBeenCalledWith('⏺ Gap 3: no drill-down');
  expect(document.querySelector('.tc-menu')).toBeNull();
  // Copy as task opens the dialog with the passage, without the frame
  rightClick();
  act(() => item('Copy as task…').click());
  expect(document.querySelector('.tc-excerpt')?.textContent).toBe('Gap 3: no drill-down');
  expect(document.querySelector('.tc-source')?.textContent).toContain('Gap finder');
});

it('says so when the selection is only frame, and answers the menu command only while shown', () => {
  show();
  fake.selection = '╭──────╮\n╰──────╯';
  rightClick();
  act(() => item('Copy as task…').click());
  expect(document.querySelector('.tc-excerpt')).toBeNull();
  expect(document.querySelector('.hs-terminal-notice')?.textContent).toContain('only the frame');
  // The terminal that had the keyboard answers the command, but not once it is hidden
  act(() => { host.querySelector('textarea')!.dispatchEvent(new FocusEvent('focus')); });
  fake.selection = 'some text';
  expect(terminalTask.current?.hasSelection()).toBe(true);
  show(false);
  expect(terminalTask.current?.hasSelection()).toBe(false);
});
