import { PLATFORM, type Platform } from './platform';

/**
 * "Copy as task" (MCR-125 v0) from the app's menu and its key: the terminal
 * that last had the keyboard puts itself here, and takes itself away when it
 * is unmounted. The command asks it whether text is selected, and opens its
 * dialog.
 */
export interface TerminalTask { hasSelection: () => boolean; open: () => void }

export const terminalTask: { current: TerminalTask | null } = { current: null };

/** The key: Cmd+Shift+C on macOS, Ctrl+Shift+C elsewhere (`commands.ts` has the same as the command's shortcut). */
export const TASK_SHORTCUT = { mod: true, shift: true, key: 'c' } as const;

/**
 * Whether a key press is Copy as task's. The terminal leaves it to the app:
 * Ctrl+Shift+C would otherwise reach the agent as Ctrl+C and stop its turn.
 * `code` too, so a layout without Latin letters has the same key.
 */
export function isTaskKey(e: KeyboardEvent, platform: Platform = PLATFORM): boolean {
  if (e.altKey || !e.shiftKey) return false;
  const mod = platform === 'macos' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && (e.key.toLowerCase() === 'c' || e.code === 'KeyC');
}
