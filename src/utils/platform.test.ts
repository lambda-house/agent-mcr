// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isPaletteKey, paletteShortcut } from './platform';

const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('the command panel key', () => {
  it('is Cmd+S on macOS only', () => {
    expect(isPaletteKey(press({ key: 's', metaKey: true }), 'macos')).toBe(true);
    expect(isPaletteKey(press({ key: 's', metaKey: true, shiftKey: true }), 'macos')).toBe(false);
    expect(isPaletteKey(press({ key: 's', ctrlKey: true }), 'macos')).toBe(false);
    expect(isPaletteKey(press({ key: 's', metaKey: true }), 'windows')).toBe(false);
    expect(paletteShortcut('macos')).toEqual({ label: '⌘S', aria: 'Meta+S' });
  });

  it('is Ctrl+Shift+P on Windows and Linux, on any keyboard layout', () => {
    for (const platform of ['windows', 'linux'] as const) {
      expect(isPaletteKey(press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }), platform)).toBe(true);
      expect(isPaletteKey(press({ key: 'З', code: 'KeyP', ctrlKey: true, shiftKey: true }), platform)).toBe(true);
      expect(isPaletteKey(press({ key: 'p', code: 'KeyP', ctrlKey: true }), platform)).toBe(false);
      expect(isPaletteKey(press({ key: 's', code: 'KeyS', ctrlKey: true }), platform)).toBe(false);
      expect(isPaletteKey(press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, altKey: true }), platform)).toBe(false);
      expect(paletteShortcut(platform)).toEqual({ label: 'Ctrl+Shift+P', aria: 'Control+Shift+P' });
    }
  });
});
