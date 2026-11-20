/**
 * The app's Back and Forward commands (Alt+Left and Alt+Right, Cmd+[ and
 * Cmd+] on macOS) go through the Live view's history while it is shown, and
 * through the document tabs otherwise (MCR-108). The Live view puts itself
 * here while it is active and takes itself away when it is not.
 */
export interface LiveNav { canBack: () => boolean; canForward: () => boolean; back: () => void; forward: () => void }

export const liveNav: { current: LiveNav | null } = { current: null };
