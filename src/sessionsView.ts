import { create } from 'zustand';

// Which view of Sessions is shown, and the hosted session Live should bring
// forward. A store of its own, so whatever navigates (the palette, Board,
// Slack, a found session) does it the same way from anywhere. The view is
// remembered per viewer; the focus is not.

const VIEW_KEY = 'agent-mcr.sessions.view';

/** Agent MCR's own views of Sessions; a plugin's come between Live and the Journal by default (order 100). */
export const SESSIONS_VIEWS = { live: 10, history: 200, board: 210, slack: 220 } as const;

/** The view chosen last, Live the first time. */
export function savedView(): string {
  try { return localStorage.getItem(VIEW_KEY) || 'live'; } catch { return 'live'; }
}

interface SessionsView {
  view: string;
  /** A hosted session to show in Live; `at` makes asking again for the same one count. */
  focus?: { id: string; at: number };
  show: (view: string) => void;
  /** Show a hosted session in Live. */
  openLive: (id: string) => void;
}

export const useSessionsView = create<SessionsView>()((set, get) => ({
  view: savedView(),
  show: (view) => {
    set({ view });
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* per-viewer convenience only */ }
  },
  openLive: (id) => {
    set({ focus: { id, at: Date.now() } });
    get().show('live');
  },
}));
