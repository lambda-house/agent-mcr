import { useCallback, useMemo } from 'react';
import { Activity, Bot, FileQuestion, FileText } from 'lucide-react';
import { EmptyState } from '@lambda-house/ui';
import { LayoutView, usePaneTypes, type Layout, type PaneZoom, type Plugin } from '@lambda-house/workbench';
import { useStore, panelShown, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, type ZoomPanel } from './store';
import { defaultDocumentsLayout } from './store/documentsLayout';
import { pluginRegistry } from './plugins';
import { documentWindowPath } from './utils/documentWindow';
import Toolbar from './components/Toolbar';
import { AgentPane } from '@lambda-house/agents';
import { agents } from './agents';
import { shortPath } from './utils/harness';
import SessionWorkspace from './components/SessionWorkspace';
import { appSettingsTabs } from './components/SettingsTabs';

// Agent MCR's own part of the window, as a plugin: the Documents surface (the
// agents' Markdown: the agent documents beside the reader's document groups
// and contents), the Sessions surface (Live, the journal, the board, Slack),
// and its Settings tabs. A memory reader window has Documents only, with its
// one document and no list.

/** An empty document group: how to open a document here. */
export const NO_DOCUMENT = (
  <EmptyState size="lg" icon={<FileQuestion size={64} />} title="No Document Open">
    Select a document from the list on the left
  </EmptyState>
);

/** A panel's zoom, kept in the store. */
export const zoomOf = (panel: ZoomPanel): PaneZoom => ({
  get: () => useStore.getState().panelZoom[panel],
  step: (_, direction) => useStore.getState().zoomPanel(panel, direction),
  subscribe: useStore.subscribe,
});

/** The Documents surface, on the workbench layout the store keeps (store/documentsLayout.ts). */
function Documents() {
  const root = useStore((s) => s.documentsLayout);
  const setDocumentsLayout = useStore((s) => s.setDocumentsLayout);
  // A memory reader window shows its one document and no list
  const filePanelVisible = panelShown({ documentsLayout: root }, 'agent-docs') && !documentWindowPath;

  // Its handles and pane menus change the layout in the store
  const layout = useMemo<Layout>(() => ({ version: 1, root }), [root]);
  const apply = useCallback((next: Layout) => setDocumentsLayout(next.root), [setDocumentsLayout]);
  const reset = useCallback(() => setDocumentsLayout(defaultDocumentsLayout({ withAgentDocs: !documentWindowPath })), [setDocumentsLayout]);
  const paneTypes = usePaneTypes(pluginRegistry.workbench, 'documents');

  return (
    <>
      <Toolbar
        filePanelVisible={filePanelVisible}
        onToggleFilePanel={documentWindowPath ? undefined : () => useStore.getState().togglePanel('agent-docs')}
      />

      <div className="main-content">
        <LayoutView layout={layout} onChange={apply} paneTypes={paneTypes} onReset={reset} />
      </div>
    </>
  );
}

/** Sessions asks for its data only while it is shown. */
function Sessions() {
  const active = useStore((s) => s.surface === 'sessions');
  return <SessionWorkspace active={active} />;
}

export const documentsPlugin: Plugin = {
  id: 'agent-mcr',
  name: 'Agent MCR',
  description: 'The Documents and Sessions surfaces, the agent documents.',
  required: true,
  setup(api) {
    // Documents is mounted only while shown; Sessions stays once opened
    api.contribute('workbench:surface', { id: 'documents', label: 'Documents', icon: <FileText size={13} />, keepMounted: false, order: 10, render: () => <Documents /> });
    if (!documentWindowPath) api.contribute('workbench:surface', { id: 'sessions', label: 'Sessions', icon: <Activity size={13} />, order: 20, render: () => <Sessions /> });
    api.contribute('workbench:pane-type', {
      view: 'documents',
      type: {
        type: 'agent-docs', label: 'agent documents', title: 'Agent documents', icon: <Bot size={14} />, singleton: true, collapsible: true,
        min: { w: PANEL_MIN_WIDTH }, max: { w: PANEL_MAX_WIDTH }, zoom: zoomOf('files'),
        render: () => <AgentPane agents={agents} folderLabel={shortPath} about="Covers the agents' own folders (Claude Code, Codex, Gemini CLI) and the folders your sessions work in." />,
      },
    });
    for (const tab of appSettingsTabs()) api.contribute('workbench:settings-tab', tab);
  },
};
