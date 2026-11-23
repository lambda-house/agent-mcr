import { create } from 'zustand';
// First: the reader store takes over the old saved tabs before this store rewrites them
import { useReader } from '../reader';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ColorTheme } from '@lambda-house/reader';
import type { AgentEntry } from '../utils/tauri';
import { DEFAULT_LIVE_LIST, type LiveListPrefs } from '../utils/harness';
import { documentWindowPath, documentWindowStorage } from '../utils/documentWindow';

// ============================================================
// Constants
// ============================================================

/** Panel zoom in/out is multiplicative, like the document's. */
const ZOOM_STEP = 1.1;

/** Persisted by versions that had a file tree; dropped when read. */
const REMOVED_KEYS = [
  'directories', 'expandedPaths', 'agentVisible', 'autoRefresh', 'showTextFiles',
  'searchScope', 'workspaces', 'activeWorkspace', 'checkUpdatesOnStart',
];

export const PANEL_MIN_WIDTH = 200;
export const PANEL_MAX_WIDTH = 400;
export const TOC_MIN_WIDTH = 180;
export const TOC_MAX_WIDTH = 320;

/** Side panels that zoom on their own (Ctrl + wheel over the panel). */
export type ZoomPanel = 'files' | 'toc';
export const MIN_PANEL_ZOOM = 50;
export const MAX_PANEL_ZOOM = 400;
const DEFAULT_PANEL_ZOOM: Record<ZoomPanel, number> = { files: 100, toc: 100 };

const clampPanelZoom = (zoom: number) =>
  Math.round(Math.max(MIN_PANEL_ZOOM, Math.min(MAX_PANEL_ZOOM, zoom)));

// ============================================================
// Types
// ============================================================

export type { Heading } from '@lambda-house/reader';

// ============================================================
// Store Interface
// ============================================================

export interface AppState {
  
  // UI State
  panelWidth: number;
  filePanelVisible: boolean;
  tocWidth: number;
  tocVisible: boolean;
  /** Zoom of the file panel and the TOC, independent of the document zoom. */
  panelZoom: Record<ZoomPanel, number>;
  statusBarVisible: boolean;
  statusBarPinned: boolean;
  /** What the Live list shows of folders and past sessions (MCR-107) */
  liveList: LiveListPrefs;

  // Appearance
  theme: ColorTheme;

  // Modal state
  settingsOpen: boolean;
  /** The command palette is showing. Not persisted. */
  paletteOpen: boolean;
  /** The command panel is mounted (it lives in Sessions). Not persisted. */
  paletteHosted: boolean;

  /** Agent files from the last scan; empty while the workspace is off. */
  agentEntries: AgentEntry[];
  /** The session folders the last scan looked through, most recent first */
  agentFolders: string[];

  // Find in document

  
  // Actions - UI
  setPanelWidth: (width: number) => void;
  setFilePanelVisible: (visible: boolean) => void;
  setTocWidth: (width: number) => void;
  setTocVisible: (visible: boolean) => void;
  toggleTocVisible: () => void;
  /** Step a panel's zoom in (1) or out (-1), or reset it to 100% (0). */
  zoomPanel: (panel: ZoomPanel, direction: 1 | -1 | 0) => void;
  setStatusBarVisible: (visible: boolean) => void;
  setStatusBarPinned: (pinned: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setPaletteHosted: (hosted: boolean) => void;
  setLiveList: (change: (prefs: LiveListPrefs) => LiveListPrefs) => void;

  // Appearance
  toggleTheme: () => void;

  setAgentEntries: (entries: AgentEntry[], folders?: string[]) => void;

}






/** The Live list's choices as they were stored, with anything that is not a list of strings or a switch dropped. */
export function normalizeLiveList(stored: unknown): LiveListPrefs {
  const v = (stored ?? {}) as Partial<Record<keyof LiveListPrefs, unknown>>;
  const strings = (x: unknown) => Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
  return {
    hiddenFolders: strings(v.hiddenFolders), shownFolders: strings(v.shownFolders), hiddenSessions: strings(v.hiddenSessions),
    hideNoise: typeof v.hideNoise === 'boolean' ? v.hideNoise : DEFAULT_LIVE_LIST.hideNoise,
  };
}






// ============================================================
// Store
// ============================================================

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      // Initial State - Files
      
      // Initial State - Documents
      
      // Initial State - UI
      panelWidth: 280,
      filePanelVisible: true,
      tocWidth: 220,
      tocVisible: true,
      panelZoom: DEFAULT_PANEL_ZOOM,
      statusBarVisible: false,
      statusBarPinned: false,
      liveList: DEFAULT_LIVE_LIST,

      // Appearance
      theme: 'dark',

      // Modal state
      settingsOpen: false,
      paletteOpen: false,
      paletteHosted: false,

      agentEntries: [],
      agentFolders: [],

      
      // ============================================================
      // Actions - UI
      // ============================================================
      
      setPanelWidth: (width) => set({ 
        panelWidth: Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, width))) 
      }),

      setFilePanelVisible: (visible) => set({ filePanelVisible: visible }),
      
      setTocWidth: (width) => set({ 
        tocWidth: Math.round(Math.max(TOC_MIN_WIDTH, Math.min(TOC_MAX_WIDTH, width))) 
      }),
      
      setTocVisible: (visible) => set({ tocVisible: visible }),
      
      toggleTocVisible: () => set((state) => ({ tocVisible: !state.tocVisible })),
      

      zoomPanel: (panel, direction) => set((state) => {
        const current = state.panelZoom[panel];
        const next = direction === 0
          ? 100
          : clampPanelZoom(direction > 0 ? current * ZOOM_STEP : current / ZOOM_STEP);
        return next === current ? state : { panelZoom: { ...state.panelZoom, [panel]: next } };
      }),
      
      setStatusBarVisible: (visible) => set((state) => (
        state.statusBarVisible === visible ? state : { statusBarVisible: visible }
      )),
      
      setStatusBarPinned: (pinned) => set({ statusBarPinned: pinned }),
      

      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setPaletteHosted: (hosted) => set({ paletteHosted: hosted }),


      setLiveList: (change) => set((state) => ({ liveList: change(state.liveList) })),



      // Appearance
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),


      setAgentEntries: (entries, folders) => set((state) => ({ agentEntries: entries, agentFolders: folders ?? state.agentFolders })),


      // Search


    }),
    {
      name: 'mdviewer-storage',
      version: 6,
      storage: createJSONStorage(() => documentWindowPath ? documentWindowStorage(localStorage) : localStorage),
      partialize: (state) => ({
        // Only persist these fields
        panelWidth: state.panelWidth,
        filePanelVisible: state.filePanelVisible,
        tocWidth: state.tocWidth,
        tocVisible: state.tocVisible,
        panelZoom: state.panelZoom,
        statusBarPinned: state.statusBarPinned,
        liveList: state.liveList,
        theme: state.theme,
      }),
      // Nothing to transform here - `merge` below normalizes every shape we
      // have ever written. Without this, zustand would silently drop the whole
      // persisted state (tabs, aliases, ...) on a version bump.
      migrate: (persistedState, version) => {
        const persisted = (persistedState ?? {}) as Partial<AppState> & Record<string, unknown>;
        // v6: tabs, zoom, edit mode and the reader settings are the reader store's
        // (reader.ts took them over before this store was created)
        if (version < 6) {
          for (const key of ['tabs', 'activeTabId', 'scrollPositions', 'zoom', 'editMode', 'smoothScroll', 'loadRemoteImages',
            'markdownTextColor', 'markdownTextColorLight', 'languageAliases', 'searchOptions']) delete persisted[key];
        }
        // v5: the file tree, text search, history and saved workspaces are gone
        if (version < 5) {
          for (const key of REMOVED_KEYS) delete (persisted as Record<string, unknown>)[key];
        }
        return persisted;
      },
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<AppState>;

        return {
          ...currentState,
          ...persisted,
          panelZoom: { ...DEFAULT_PANEL_ZOOM, ...persisted.panelZoom },
          liveList: normalizeLiveList(persisted.liveList),
        };
      },
    }
  )
);

// The reader renders in the app's theme
useReader.getState().setTheme(useStore.getState().theme);
useStore.subscribe((state, prev) => {
  if (state.theme !== prev.theme) useReader.getState().setTheme(state.theme);
});

export default useStore;
