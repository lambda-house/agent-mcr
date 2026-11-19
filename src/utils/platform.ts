export type Platform = 'macos' | 'windows' | 'linux';

function detectPlatform(): Platform {
  const name = navigator.platform || navigator.userAgent;
  if (/mac|iphone|ipad/i.test(name)) return 'macos';
  if (/win/i.test(name)) return 'windows';
  return 'linux';
}

/** The system the app runs on, for its conventions (shortcut names, button order). */
export const PLATFORM: Platform = detectPlatform();

/**
 * Where a dialog puts the button that goes ahead. Windows has it first and
 * Cancel last; macOS and Linux (GNOME) have Cancel first and the action last,
 * in the corner.
 */
export const ACTION_BUTTON_FIRST = PLATFORM === 'windows';

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
