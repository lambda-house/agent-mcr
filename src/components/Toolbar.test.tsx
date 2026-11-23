// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Toolbar from './Toolbar';
import { controlsIn, dragsWindow } from '../utils/dragRegion.testing';
import type { TitleBar } from '../utils/windowChrome';
import type { MenuItem } from '../utils/commands';

const chrome = vi.hoisted(() => ({ bar: 'native' as TitleBar }));
vi.mock('../utils/windowChrome', async importOriginal => ({ ...await importOriginal<object>(), useTitleBar: () => chrome.bar }));

const menu: MenuItem[] = [{ label: 'File', items: [{ id: 'file.close', label: 'Close', run: () => {} }, 'separator', { id: 'file.quit', label: 'Quit', run: () => {} }] }];
let root: Root; let host: HTMLDivElement;
const draw = async (bar: TitleBar) => {
  chrome.bar = bar;
  await act(async () => root.render(<Toolbar menu={menu} onOpenSessions={() => {}} filePanelVisible onToggleFilePanel={() => {}}/>));
  return host.querySelector('header.toolbar') as HTMLElement;
};
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { chrome.bar = 'native'; await act(async () => root.unmount()); host.remove(); });

describe('the Documents toolbar as the window top row', () => {
  it('leaves 80 px for the traffic lights and drags by its empty space, never by a control', async () => {
    const row = await draw('overlay');
    expect(row.getAttribute('data-titlebar')).toBe('overlay');
    expect(row.style.paddingLeft).toBe('80px');
    expect(dragsWindow(row)).toBe(true);
    expect(dragsWindow(row.querySelector('.toolbar-spacer')!)).toBe(true);
    expect(dragsWindow(row.querySelector('.toolbar-separator')!)).toBe(true);
    const controls = controlsIn(row);
    expect(controls.length).toBeGreaterThanOrEqual(8);
    for (const c of controls) for (const el of [c, ...c.querySelectorAll('*')]) expect(dragsWindow(el), el.outerHTML.slice(0, 80)).toBe(false);
  });

  it('keeps the open main menu out of the drag region, its frame and separators too', async () => {
    const row = await draw('overlay');
    await act(async () => (row.querySelector('.main-menu > button') as HTMLButtonElement).click());
    const opened = [...row.querySelectorAll('.main-menu *')];
    expect(opened.some(el => el.getAttribute('role') === 'menu')).toBe(true);
    for (const el of opened) expect(dragsWindow(el), el.outerHTML.slice(0, 80)).toBe(false);
  });

  it('drops the inset and the drag region in full screen, and has neither with a native title bar', async () => {
    const full = await draw('fullscreen');
    expect(full.style.paddingLeft).toBe('');
    expect(full.hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(dragsWindow(full)).toBe(false);
    const native = await draw('native');
    expect(native.hasAttribute('data-titlebar')).toBe(false);
    expect(native.hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(native.getAttribute('style')).toBeNull();
  });
});
