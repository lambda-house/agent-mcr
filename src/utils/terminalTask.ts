import { PLATFORM, type Platform } from './platform';

/**
 * "Copy as task" (MCR-125 v0) from the app's menu and its key: the terminal
 * that last had the keyboard puts itself here, and takes itself away when it
 * is unmounted. The command asks it whether text is selected, and opens its
 * dialog.
 */
export interface TerminalTask { hasSelection: () => boolean; open: () => void }

export const terminalTask: { current: TerminalTask | null } = { current: null };

/**
 * The key, on macOS only: Cmd+Shift+C. On Windows and Linux Ctrl+Shift+C is
 * the terminal's copy, as in Windows Terminal and GNOME Terminal (MCR-125
 * review L2), so there the task is in the menus only.
 */
export const TASK_SHORTCUT = { mod: true, shift: true, key: 'c' } as const;

const isC = (e: KeyboardEvent) => e.key.toLowerCase() === 'c' || e.code === 'KeyC';

/** Copy as task's key (macOS). The terminal leaves it to the app. `code` too, for a layout without Latin letters. */
export function isTaskKey(e: KeyboardEvent, platform: Platform = PLATFORM): boolean {
  return platform === 'macos' && !e.altKey && e.shiftKey && e.metaKey && !e.ctrlKey && isC(e);
}

/**
 * Ctrl+Shift+C on Windows and Linux: copy the selection. Never handed to the
 * agent, which would take it for Ctrl+C and stop its turn.
 */
export function isCopyKey(e: KeyboardEvent, platform: Platform = PLATFORM): boolean {
  return platform !== 'macos' && !e.altKey && e.shiftKey && e.ctrlKey && !e.metaKey && isC(e);
}
