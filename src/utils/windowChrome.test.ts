import { describe, expect, it } from 'vitest';
import { followFullscreen, hasOverlayTitleBar, titleBar, topRowInset, topRowProps, TRAFFIC_LIGHT_INSET, type FullscreenSource } from './windowChrome';

describe('the window title bar', () => {
  it('is an overlay for the main window on macOS only', () => {
    expect(hasOverlayTitleBar('macos', true, false)).toBe(true);
    // A memory reader window keeps the default chrome Rust opens it with
    expect(hasOverlayTitleBar('macos', true, true)).toBe(false);
    // In a browser (the Vite dev server) there is no window chrome at all
    expect(hasOverlayTitleBar('macos', false, false)).toBe(false);
    expect(hasOverlayTitleBar('windows', true, false)).toBe(false);
    expect(hasOverlayTitleBar('linux', true, false)).toBe(false);
  });

  it('leaves room for the traffic lights, except in full screen, where macOS hides them', () => {
    expect(titleBar(true, false)).toBe('overlay');
    expect(titleBar(true, true)).toBe('fullscreen');
    expect(titleBar(false, true)).toBe('native');
    expect(topRowInset('overlay')).toBe(TRAFFIC_LIGHT_INSET);
    // MCR-145: the lights end at 14 + 60, and the row starts 14 px after them
    expect(TRAFFIC_LIGHT_INSET).toBe(88);
    expect(topRowInset('fullscreen')).toBe(0);
    expect(topRowInset('native')).toBe(0);
  });

  it('makes the top row a drag region only while the lights are over it', () => {
    expect(topRowProps('overlay')).toEqual({ 'data-titlebar': 'overlay', 'data-tauri-drag-region': 'deep', style: { paddingLeft: 88 } });
    expect(topRowProps('fullscreen')).toEqual({ 'data-titlebar': 'fullscreen' });
    // Windows and Linux get the row they had: no attribute, no inset
    expect(topRowProps('native')).toEqual({});
  });
});

describe('following full screen', () => {
  const fakeWindow = () => {
    let handler: (() => void) | null = null;
    const answers: Array<(fs: boolean) => void> = [];
    let unlistened = false;
    const win: FullscreenSource = {
      isFullscreen: () => new Promise(resolve => answers.push(resolve)),
      onResized: async h => { handler = h; return () => { unlistened = true; }; },
    };
    return { win, resize: () => handler?.(), answers, unlistened: () => unlistened };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('asks at the start and after every resize, and keeps only the newest answer', async () => {
    const w = fakeWindow();
    const seen: boolean[] = [];
    const stop = await followFullscreen(w.win, fs => seen.push(fs));
    expect(w.answers).toHaveLength(1);
    w.answers[0](false);
    await settle();
    expect(seen).toEqual([false]);
    // Two resizes while entering full screen, answered out of order
    w.resize(); w.resize();
    w.answers[2](true); w.answers[1](false);
    await settle();
    expect(seen).toEqual([false, true]);
    stop();
    expect(w.unlistened()).toBe(true);
    w.resize();
    w.answers[3](false);
    await settle();
    expect(seen).toEqual([false, true]);
  });
});
