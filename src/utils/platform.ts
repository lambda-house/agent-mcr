// The conventions shared with MDViewer (dialog button order) live in @lambda-house/ui.
import type { Platform } from '@lambda-house/ui';
import { PALETTE_SHORTCUT, ariaShortcut, formatShortcut, matchesShortcut } from '@lambda-house/workbench';
export { PLATFORM, ACTION_BUTTON_FIRST, type Platform } from '@lambda-house/ui';

// The command panel's key is the workbench's palette key: Ctrl+Shift+P, and ⇧⌘P on macOS, where ⌘S is Save.

/** The panel's key as the platform writes it, and for aria-keyshortcuts. */
export function paletteShortcut(platform: Platform): { label: string; aria: string } {
  return { label: formatShortcut(PALETTE_SHORTCUT, platform), aria: ariaShortcut(PALETTE_SHORTCUT, platform) };
}

/** Whether a key press is the panel's key, on any keyboard layout (a terminal lets it through). */
export function isPaletteKey(e: KeyboardEvent): boolean {
  return matchesShortcut(e, PALETTE_SHORTCUT);
}
