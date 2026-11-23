import { closeLeaf, findPaneOfType, type LayoutNode } from '@lambda-house/workbench';
import { defaultDocumentsLayout, documentsLayoutFrom, isDocumentsLayout } from '../store/documentsLayout';

export const documentWindowPath = typeof window === 'undefined'
  ? null : new URLSearchParams(window.location.search).get('memoryDocument');

/**
 * Inherit display preferences (the theme, the contents panel), but never
 * share tabs or write the main workspace. A memory window has no agent documents.
 */
export function documentWindowStorage(source: Pick<Storage, 'getItem'>) {
  return {
    getItem: () => {
      let theme: unknown;
      let documentsLayout: LayoutNode | null = null;
      try {
        const saved = JSON.parse(source.getItem('mdviewer-storage') || '{}');
        const state = saved.state || {};
        theme = state.theme;
        const layout = (saved.version ?? 0) < 7 ? documentsLayoutFrom(state, false) : state.documentsLayout;
        if (isDocumentsLayout(layout)) {
          const agentDocs = findPaneOfType(layout, 'agent-docs');
          documentsLayout = agentDocs ? closeLeaf(layout, agentDocs.id) : layout;
        }
      } catch { /* Use the defaults if the saved preferences are invalid. */ }
      return JSON.stringify({ version: 7, state: {
        ...(theme ? { theme } : {}),
        documentsLayout: documentsLayout ?? defaultDocumentsLayout({ withAgentDocs: false }),
      } });
    },
    setItem: () => {},
    removeItem: () => {},
  };
}

/** The reader's side of a memory window: the main window's reader settings and zoom, no tabs, nothing written. */
export function documentWindowReaderStorage(source: Pick<Storage, 'getItem'>) {
  return {
    getItem: () => {
      let settings: unknown;
      let zoom = 100;
      try {
        const saved = JSON.parse(source.getItem('mdviewer-reader') || '{}').state || {};
        settings = saved.settings;
        const group = saved.groups?.[saved.focusedGroup];
        if (typeof group?.zoom === 'number') zoom = group.zoom;
      } catch { /* Use the reader defaults if the saved preferences are invalid. */ }
      return JSON.stringify({ version: 1, state: {
        settings, editMode: false, focusedGroup: 'main', groups: { main: { id: 'main', zoom, tabs: [], activeTabId: null } },
      } });
    },
    setItem: () => {},
    removeItem: () => {},
  };
}
