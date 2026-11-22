// The conventions shared with MDViewer (dialog button order) live in @lambda-house/ui.
import type { Platform } from '@lambda-house/ui';
export { PLATFORM, ACTION_BUTTON_FIRST, type Platform } from '@lambda-house/ui';

/**
 * The key that opens the command panel: Cmd+S on macOS. Elsewhere Ctrl+S is
 * taken (Save in Documents, history search and XOFF in a shell) and there is
 * no Cmd, so it is Ctrl+Shift+P, the palette key of Windows Terminal and VS Code.
 */
export function paletteShortcut(platform: Platform): { label: string; aria: string } {
  return platform === 'macos'
    ? { label: '⌘S', aria: 'Meta+S' }
    : { label: 'Ctrl+Shift+P', aria: 'Control+Shift+P' };
}

/** Whether a key press opens the command panel on this platform. */
export function isPaletteKey(e: KeyboardEvent, platform: Platform): boolean {
  if (e.altKey) return false;
  if (platform === 'macos') {
    return e.metaKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 's';
  }
  // `code` too: on a Cyrillic or Greek layout `key` is not a Latin letter
  return e.ctrlKey && e.shiftKey && !e.metaKey && (e.key.toLowerCase() === 'p' || e.code === 'KeyP');
}
