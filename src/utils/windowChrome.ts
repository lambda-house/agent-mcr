import { useSyncExternalStore } from 'react';
import type { TitleBar } from '@lambda-house/workbench';
import { PLATFORM, type Platform } from './platform';
import { isTauri } from './tauri';
import { documentWindowPath } from './documentWindow';

/*
 * The window's top row (MCR-138). On macOS the main window has an overlay
 * title bar (src-tauri/tauri.macos.conf.json): no title row of its own, the
 * traffic lights drawn over the app's top row, the workbench's top bar. That
 * bar then leaves room for the lights, and its empty space moves the window
 * and zooms it on a double-click, as a title bar does. Windows and Linux keep
 * their native title bar, and so do the memory reader windows, which Rust
 * opens with the default chrome.
 *
 * The bar's side (the lights' geometry, MCR-145, its attributes and the
 * no-drag mark) is the workbench's `titleBar.ts`: the Workbench gets
 * `titleBar={useTitleBar()}`. tauri.macos.conf.json's trafficLightPosition
 * {x 14, y 21} is what its TRAFFIC_LIGHT_X and --titlebar-height are measured
 * for. What is here needs Tauri: which window this is, and full screen.
 */
export { NO_DRAG, TRAFFIC_LIGHT_INSET, TRAFFIC_LIGHT_X, TRAFFIC_LIGHTS_WIDTH, topRowInset, topRowProps, type TitleBar, type TopRowProps } from '@lambda-house/workbench';

/** Whether this window has the overlay title bar: the main window of the app on macOS. */
export function hasOverlayTitleBar(platform: Platform, tauri: boolean, readerWindow: boolean): boolean {
  return platform === 'macos' && tauri && !readerWindow;
}

export function titleBar(overlay: boolean, fullscreen: boolean): TitleBar {
  if (!overlay) return 'native';
  return fullscreen ? 'fullscreen' : 'overlay';
}

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
