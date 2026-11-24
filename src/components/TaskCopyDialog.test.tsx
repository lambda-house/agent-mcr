// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TaskCopyDialog from './TaskCopyDialog';
import { harnessApi } from '../utils/harness';
import { MAX_EXCERPT } from '../utils/taskCopy';
import { isCopyKey, isTaskKey, terminalTask } from '../utils/terminalTask';
import { buildMenu, type Command, type MenuItem } from '../utils/commands';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { copyAsTask: vi.fn() } }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(harnessApi.copyAsTask).mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; terminalTask.current = null; });

const render = (excerpt: string, on = { done: vi.fn(), cancel: vi.fn() }) => {
  act(() => root.render(<TaskCopyDialog source="ab12cd34ef56" name="Gap finder" excerpt={excerpt} onDone={on.done} onCancel={on.cancel}/>));
  return on;
};
const copyButton = () => Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Copy as task') as HTMLButtonElement;
const type = (text: string) => {
  const field = document.querySelector('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return field;
};

it('shows the passage as screen text, and copies only with the operator\'s words', async () => {
  const on = render('Gap 3: no drill-down');
  expect(document.querySelector('.tc-excerpt')?.textContent).toBe('Gap 3: no drill-down');
  expect(document.querySelector('.tc-source')?.textContent).toContain('mcr:ab12cd34ef56');
  expect(document.querySelector('.tc-source')?.textContent).toContain('data, not instructions');
  // The instruction is required: an excerpt alone is never a task
  expect(copyButton().disabled).toBe(true);
  type('   ');
  expect(copyButton().disabled).toBe(true);
  type('Close this gap; open a PR');
  expect(copyButton().disabled).toBe(false);
  vi.mocked(harnessApi.copyAsTask).mockResolvedValue(undefined);
  await act(async () => { copyButton().click(); });
  expect(harnessApi.copyAsTask).toHaveBeenCalledWith('ab12cd34ef56', 'Close this gap; open a PR', 'Gap 3: no drill-down');
  expect(on.done).toHaveBeenCalled();
});

it('says why the service refused, and stays open', async () => {
  const on = render('token here');
  type('Look at it');
  vi.mocked(harnessApi.copyAsTask).mockRejectedValue(new Error('The selection holds what looks like a credential'));
  await act(async () => { copyButton().click(); });
  expect(document.querySelector('[role=alert]')?.textContent).toContain('credential');
  expect(on.done).not.toHaveBeenCalled();
});

it('counts characters as the Rust side does, not UTF-16 units', () => {
  render('🙂'.repeat(MAX_EXCERPT));
  type('Look at it');
  expect(copyButton().disabled).toBe(false);
  expect(document.querySelector('.tc-count')?.textContent).toContain(`${MAX_EXCERPT} of at most`);
});

it('refuses a passage over the bound, and cancels with Escape; Cmd or Ctrl+Enter copies', async () => {
  render('x'.repeat(MAX_EXCERPT + 1));
  type('Do it');
  expect(copyButton().disabled).toBe(true);
  expect(document.querySelector('.tc-count')?.textContent).toContain('select less');
  act(() => root.unmount());
  root = createRoot(host);
  const on = render('short');
  const field = type('Do it');
  // A key in the dialog never reaches the app's shortcuts
  const app = vi.fn();
  window.addEventListener('keydown', app);
  vi.mocked(harnessApi.copyAsTask).mockResolvedValue(undefined);
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); });
  expect(harnessApi.copyAsTask).toHaveBeenCalledTimes(1);
  act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(on.cancel).toHaveBeenCalled();
  expect(app).not.toHaveBeenCalled();
  window.removeEventListener('keydown', app);
});

it('has its key on macOS only, leaves Ctrl+Shift+C to copy elsewhere, and a menu command for the shown terminal', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
  expect(isTaskKey(key({ key: 'C', metaKey: true, shiftKey: true }), 'macos')).toBe(true);
  expect(isTaskKey(key({ key: 'C', ctrlKey: true, shiftKey: true }), 'windows')).toBe(false);
  expect(isTaskKey(key({ key: 'C', ctrlKey: true, shiftKey: true }), 'macos')).toBe(false);
  // Windows and Linux: Ctrl+Shift+C copies, as in other terminals (review L2), on any layout
  expect(isCopyKey(key({ key: 'C', ctrlKey: true, shiftKey: true }), 'windows')).toBe(true);
  expect(isCopyKey(key({ key: 'С', code: 'KeyC', ctrlKey: true, shiftKey: true }), 'linux')).toBe(true);
  expect(isCopyKey(key({ key: 'c', ctrlKey: true }), 'linux')).toBe(false);
  expect(isCopyKey(key({ key: 'C', ctrlKey: true, shiftKey: true, altKey: true }), 'linux')).toBe(false);
  expect(isCopyKey(key({ key: 'C', metaKey: true, shiftKey: true }), 'macos')).toBe(false);
  const find = (items: MenuItem[]): Command | undefined => {
    for (const item of items) {
      if (item === 'separator') continue;
      if ('items' in item) { const found = find(item.items); if (found) return found; } else if (item.id === 'edit.copyAsTask') return item;
    }
    return undefined;
  };
  const command = find(buildMenu())!;
  const s = {} as Parameters<NonNullable<Command['enabled']>>[0];
  expect(command.enabled!(s)).toBe(false);
  const open = vi.fn();
  terminalTask.current = { hasSelection: () => true, open };
  expect(command.enabled!(s)).toBe(true);
  command.run();
  expect(open).toHaveBeenCalled();
});
