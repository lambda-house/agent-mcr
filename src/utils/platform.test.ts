// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isPaletteKey, paletteShortcut } from './platform';

const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('the command panel key', () => {
  it('is ⇧⌘P on macOS, where ⌘S is Save', () => {
    expect(isPaletteKey(press({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }))).toBe(true);
    expect(isPaletteKey(press({ key: 's', metaKey: true }))).toBe(false);
    expect(isPaletteKey(press({ key: 's', metaKey: true, shiftKey: true }))).toBe(false);
    expect(paletteShortcut('macos')).toEqual({ label: '⇧⌘P', aria: 'Meta+Shift+P' });
  });

  it('is Ctrl+Shift+P on Windows and Linux, on any keyboard layout', () => {
    for (const platform of ['windows', 'linux'] as const) {
      expect(paletteShortcut(platform)).toEqual({ label: 'Ctrl+Shift+P', aria: 'Control+Shift+P' });
    }
    expect(isPaletteKey(press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPaletteKey(press({ key: 'З', code: 'KeyP', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPaletteKey(press({ key: 'p', code: 'KeyP', ctrlKey: true }))).toBe(false);
    expect(isPaletteKey(press({ key: 's', code: 'KeyS', ctrlKey: true }))).toBe(false);
    expect(isPaletteKey(press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
  });
});
