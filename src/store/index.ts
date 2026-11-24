import { create } from 'zustand';
// First: the reader store takes over the old saved tabs before this store rewrites them
import { useReader } from '../reader';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ColorTheme } from '@lambda-house/reader';
import { DEFAULT_LIVE_LIST, type LiveListPrefs } from '../utils/harness';
import { documentWindowPath, documentWindowStorage } from '../utils/documentWindow';
import { stepPaneZoom, type LayoutNode } from '@lambda-house/workbench';
import { defaultDocumentsLayout, documentsLayoutFrom, hidePane, isDocumentsLayout, isPaneShown, showPane, togglePane, type DocumentsPane } from './documentsLayout';

export { PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, TOC_MIN_WIDTH, TOC_MAX_WIDTH, type DocumentsPane } from './documentsLayout';

// ============================================================
// Constants
// ============================================================

/** Persisted by versions that had a file tree; dropped when read. */
const REMOVED_KEYS = [
  'directories', 'expandedPaths', 'agentVisible', 'autoRefresh', 'showTextFiles',
  'searchScope', 'workspaces', 'activeWorkspace', 'checkUpdatesOnStart',
];


/** Side panels that zoom on their own (Ctrl + wheel over the panel), on the workbench's pane zoom scale. */
export type ZoomPanel = 'files' | 'toc';
const DEFAULT_PANEL_ZOOM: Record<ZoomPanel, number> = { files: 100, toc: 100 };

// ============================================================
// Types
// ============================================================

export type { Heading } from '@lambda-house/reader';

// ============================================================
// Store Interface
// ============================================================

export interface AppState {
  
  // UI State
  /** The Documents view: agent documents, document groups, contents, as a workbench layout (documentsLayout.ts). */
  documentsLayout: LayoutNode;
  /** Zoom of the file panel and the TOC, independent of the document zoom. */
  panelZoom: Record<ZoomPanel, number>;
  statusBarPinned: boolean;
  /** What the Live list shows of folders and past sessions (MCR-107) */
  liveList: LiveListPrefs;

  // Appearance
  theme: ColorTheme;

  /** The shown surface of the window ('documents', 'sessions'): commands of another one wait. Not persisted. */
  surface: string;
  setSurface: (surface: string) => void;

  // Modal state
  settingsOpen: boolean;
  /** The command palette is showing. Not persisted. */
  paletteOpen: boolean;
  /** The command panel is mounted (it lives in Sessions). Not persisted. */
  paletteHosted: boolean;

  // Find in document

  
  // Actions - UI
  /** The Documents layout after a resize or a pane menu; ignored unless Agent MCR can draw it. */
  setDocumentsLayout: (layout: LayoutNode) => void;
  showPanel: (panel: DocumentsPane) => void;
  hidePanel: (panel: DocumentsPane) => void;
  togglePanel: (panel: DocumentsPane) => void;
  setFilePanelVisible: (visible: boolean) => void;
  setTocVisible: (visible: boolean) => void;
  toggleTocVisible: () => void;
  /** Step a panel's zoom in (1) or out (-1), or reset it to 100% (0). */
  zoomPanel: (panel: ZoomPanel, direction: 1 | -1 | 0) => void;
  setStatusBarPinned: (pinned: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setPaletteHosted: (hosted: boolean) => void;
  setLiveList: (change: (prefs: LiveListPrefs) => LiveListPrefs) => void;

  // Appearance
  setTheme: (theme: ColorTheme) => void;


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
    (set, get) => ({
      // Initial State - Files
      
      // Initial State - Documents
      
      // Initial State - UI
      documentsLayout: defaultDocumentsLayout({ withAgentDocs: !documentWindowPath }),
      surface: documentWindowPath ? 'documents' : 'sessions',
      panelZoom: DEFAULT_PANEL_ZOOM,
      statusBarPinned: false,
      liveList: DEFAULT_LIVE_LIST,

      // Appearance
      theme: 'dark',

      // Modal state
      settingsOpen: false,
      paletteOpen: false,
      paletteHosted: false,

      
      // ============================================================
      // Actions - UI
      // ============================================================
      
      setDocumentsLayout: (layout) => {
        if (layout !== get().documentsLayout && isDocumentsLayout(layout)) set({ documentsLayout: layout });
      },
      showPanel: (panel) => set((state) => ({ documentsLayout: showPane(state.documentsLayout, panel) })),
      hidePanel: (panel) => set((state) => ({ documentsLayout: hidePane(state.documentsLayout, panel) })),
      togglePanel: (panel) => set((state) => ({ documentsLayout: togglePane(state.documentsLayout, panel) })),
      setFilePanelVisible: (visible) => (visible ? get().showPanel('agent-docs') : get().hidePanel('agent-docs')),
      setTocVisible: (visible) => (visible ? get().showPanel('contents') : get().hidePanel('contents')),
      toggleTocVisible: () => get().togglePanel('contents'),
      

      zoomPanel: (panel, direction) => set((state) => {
        const current = state.panelZoom[panel];
        const next = stepPaneZoom(current, direction);
        return next === current ? state : { panelZoom: { ...state.panelZoom, [panel]: next } };
      }),
      
      setStatusBarPinned: (pinned) => set({ statusBarPinned: pinned }),
      

      setSurface: (surface) => set({ surface }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setPaletteHosted: (hosted) => set({ paletteHosted: hosted }),


      setLiveList: (change) => set((state) => ({ liveList: change(state.liveList) })),



      // Appearance
      setTheme: (theme) => set({ theme }),




      // Search


    }),
    {
      name: 'mdviewer-storage',
      version: 7,
      storage: createJSONStorage(() => documentWindowPath ? documentWindowStorage(localStorage) : localStorage),
      partialize: (state) => ({
        // Only persist these fields
        documentsLayout: state.documentsLayout,
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
        // v7: the side panels' widths and visibility are the Documents layout
        if (version < 7) {
          persisted.documentsLayout = documentsLayoutFrom(persisted, !documentWindowPath);
          for (const key of ['panelWidth', 'filePanelVisible', 'tocWidth', 'tocVisible']) delete persisted[key];
        }
        return persisted;
      },
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<AppState>;

        return {
          ...currentState,
          ...persisted,
          documentsLayout: isDocumentsLayout(persisted.documentsLayout) ? persisted.documentsLayout : currentState.documentsLayout,
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

/** Whether a panel of the Documents view shows. */
export const panelShown = (state: Pick<AppState, 'documentsLayout'>, panel: DocumentsPane): boolean => isPaneShown(state.documentsLayout, panel);

export default useStore;
