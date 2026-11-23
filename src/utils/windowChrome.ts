import { useSyncExternalStore, type CSSProperties } from 'react';
import { PLATFORM, type Platform } from './platform';
import { isTauri } from './tauri';
import { documentWindowPath } from './documentWindow';

/*
 * The window's top row (MCR-138). On macOS the main window has an overlay
 * title bar (src-tauri/tauri.macos.conf.json): no title row of its own, the
 * traffic lights drawn over the app's top row (the Documents toolbar or the
 * Sessions bar). That row then leaves room for the lights, and its empty
 * space moves the window and zooms it on a double-click, as a title bar does.
 * Windows and Linux keep their native title bar, and so do the memory reader
 * windows, which Rust opens with the default chrome.
 */

/** Room at the left of the top row for the traffic lights (placed at x 14 by tauri.macos.conf.json). */
export const TRAFFIC_LIGHT_INSET = 80;

/**
 * `native`: the system draws the title bar, the top row is an ordinary row.
 * `overlay`: the lights are over the top row. `fullscreen`: an overlay window
 * in full screen, where macOS hides the lights, so the row needs no room for them.
 */
export type TitleBar = 'native' | 'overlay' | 'fullscreen';

/** Whether this window has the overlay title bar: the main window of the app on macOS. */
export function hasOverlayTitleBar(platform: Platform, tauri: boolean, readerWindow: boolean): boolean {
  return platform === 'macos' && tauri && !readerWindow;
}

export function titleBar(overlay: boolean, fullscreen: boolean): TitleBar {
  if (!overlay) return 'native';
  return fullscreen ? 'fullscreen' : 'overlay';
}

/** Left inset of the top row, in CSS pixels. */
export function topRowInset(bar: TitleBar): number {
  return bar === 'overlay' ? TRAFFIC_LIGHT_INSET : 0;
}

export interface TopRowProps {
  'data-titlebar'?: TitleBar;
  /**
   * Tauri's drag script (tauri 2.12, `window/scripts/drag.js`): `deep` makes
   * a press anywhere in the row drag the window and a double-click zoom it,
   * except on what can be clicked (buttons, inputs, links, `role="tab"` and
   * the like) and below an element marked `false` (`NO_DRAG`).
   */
  'data-tauri-drag-region'?: 'deep';
  style?: CSSProperties;
}

/**
 * The attributes of the top row. Nothing for a native title bar, so Windows
 * and Linux get the row they had. No drag region in full screen, where the
 * window cannot be moved and a double-click must not unzoom it.
 */
export function topRowProps(bar: TitleBar): TopRowProps {
  if (bar === 'native') return {};
  if (bar === 'fullscreen') return { 'data-titlebar': bar };
  return { 'data-titlebar': bar, 'data-tauri-drag-region': 'deep', style: { paddingLeft: topRowInset(bar) } };
}

/**
 * For a part of the top row that reacts to the pointer without being a
 * button (a menu's frame, a popover, a hover control): a press there is not
 * a drag. Without a drag region above it, the attribute does nothing.
 */
export const NO_DRAG = { 'data-tauri-drag-region': 'false' } as const;

/** The part of a Tauri window this needs; a fake in tests. */
export interface FullscreenSource {
  isFullscreen(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}

/**
 * Tells `set` whether the window is in full screen now and after every
 * resize (entering and leaving full screen resize the window). Returns the
 * function that stops it.
 */
export async function followFullscreen(win: FullscreenSource, set: (fullscreen: boolean) => void): Promise<() => void> {
  let stopped = false;
  let asked = 0;
  const check = () => {
    // Only the newest answer counts: two resizes may be answered out of order
    const mine = ++asked;
    win.isFullscreen().then(fs => { if (!stopped && mine === asked) set(fs); }, () => {});
  };
  const unlisten = await win.onResized(check);
  check();
  return () => { stopped = true; unlisten(); };
}

const OVERLAY = typeof window !== 'undefined' && hasOverlayTitleBar(PLATFORM, isTauri(), documentWindowPath !== null);
let fullscreen = false;
let following = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (OVERLAY && !following) {
    following = true;
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => followFullscreen(getCurrentWindow(), fs => {
        if (fs === fullscreen) return;
        fullscreen = fs;
        listeners.forEach(l => l());
      }))
      .catch(error => console.error('Failed to follow full screen:', error));
  }
  return () => { listeners.delete(listener); };
}

/** The title bar of this window, following full screen. */
export function useTitleBar(): TitleBar {
  const fs = useSyncExternalStore(subscribe, () => fullscreen, () => false);
  return titleBar(OVERLAY, fs);
}
