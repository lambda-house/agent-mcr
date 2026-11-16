import { useEffect, useRef, useState } from 'react';
import { Columns2, Eye, FilePlus, FileText, Pencil, Rows2, Save, X } from 'lucide-react';
import LiveDocPane from '../../components/LiveDocPane';
import { useStore } from '../../store';
import { getFileName } from '../../utils/files';
import { saveDocumentToDisk } from '../../utils/save';
import { pickFiles, readFile } from '../../utils/tauri';
import { listLeaves } from '../../utils/paneLayout';
import { createPlugin, pluginRegistry, type LiveControllerContext } from '../sdk';

const editState = new Map<string, boolean>();
const editListeners = new Set<() => void>();

function useDocEditing(path: string): [boolean, () => void] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick(t => t + 1);
    editListeners.add(fn);
    return () => { editListeners.delete(fn); };
  }, []);
  const editing = !!editState.get(path);
  const toggle = () => {
    editState.set(path, !editState.get(path));
    editListeners.forEach(fn => fn());
  };
  return [editing, toggle];
}

async function pickAndOpenDocuments(controller: LiveControllerContext, targetLeafId?: string): Promise<void> {
  try {
    const paths = await pickFiles();
    const { openDocument } = useStore.getState();
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const existing = useStore.getState().documents[path];
      if (existing === undefined) {
        const content = await readFile(path);
        openDocument(path, content, { preview: false });
      }
      const item = { kind: 'doc', path } as const;
      if (i === 0 && targetLeafId) controller.assignPaneItem(targetLeafId, item);
      else controller.openItem(item);
      pluginRegistry.emitEvent('doc:opened', { path });
    }
  } catch (e) {
    controller.reportError(e instanceof Error ? e.message : String(e));
  }
}

function DocPaneTitle({
  leafId,
  path,
  controller,
}: {
  leafId: string;
  path: string;
  controller: LiveControllerContext;
}) {
  const docRecord = useStore(s => s.documents[path]);
  const [editing, toggleEdit] = useDocEditing(path);

  const handleSave = async () => {
    await saveDocumentToDisk(path);
    pluginRegistry.emitEvent('doc:saved', { path });
  };

  return (
    <header className="hs-pane-title">
      <FileText size={13}/>
      <strong>{getFileName(path)}</strong>
      {docRecord?.isDirty && <span className="hs-doc-dirty" title="Unsaved changes">●</span>}
      <span title={path}>{path}</span>
      <div className="hs-pane-tools">
        {docRecord?.isDirty && (
          <button
            type="button"
            className="hs-pane-btn hs-pane-btn--text"
            aria-label="Save document"
            title="Save"
            onClick={e => { e.stopPropagation(); void handleSave(); }}
          >
            <Save size={12}/> Save
          </button>
        )}
        <button
          type="button"
          className="hs-pane-btn hs-pane-btn--text"
          aria-pressed={editing}
          aria-label={editing ? 'Preview document' : 'Edit document'}
          title={editing ? 'Preview' : 'Edit'}
          onClick={e => { e.stopPropagation(); toggleEdit(); }}
        >
          {editing ? <><Eye size={12}/> Preview</> : <><Pencil size={12}/> Edit</>}
        </button>
        <button type="button" className="hs-pane-btn" aria-label="Split right" title="Split right" onClick={e => { e.stopPropagation(); controller.splitPane(leafId, 'row'); }}><Columns2 size={13}/></button>
        <button type="button" className="hs-pane-btn" aria-label="Split down" title="Split down" onClick={e => { e.stopPropagation(); controller.splitPane(leafId, 'col'); }}><Rows2 size={13}/></button>
        <button type="button" className="hs-pane-btn" aria-label="Close pane" title="Close pane" onClick={e => { e.stopPropagation(); controller.closePane(leafId); }}><X size={13}/></button>
      </div>
    </header>
  );
}

function DocPaneBody({ path }: { path: string }) {
  const [editing] = useDocEditing(path);
  return <LiveDocPane path={path} editing={editing}/>;
}

function DocumentsSidebar({ controller }: { controller: LiveControllerContext }) {
  const openTabs = useStore(s => s.tabs);
  const documents = useStore(s => s.documents);
  const activeTabId = useStore(s => s.activeTabId);
  const setActiveTab = useStore(s => s.setActiveTab);
  const closeTabs = useStore(s => s.closeTabs);
  const lastSyncedPath = useRef<string | null>(null);

  // Sync documents opened externally (Cmd+O, drag-drop, etc.) into the focused Live pane
  useEffect(() => {
    const activeTab = openTabs.find(t => t.id === activeTabId);
    const path = activeTab?.path ?? null;
    if (!path || path === lastSyncedPath.current) return;
    lastSyncedPath.current = path;
    controller.openItem({ kind: 'doc', path });
  }, [activeTabId, openTabs, controller]);

  const activeLeaves = listLeaves(controller.layout);

  return (
    <>
      <div className="hs-docs-header">
        <span className="hs-section-label">Documents</span>
        <button
          type="button"
          className="hs-docs-open-btn"
          title="Open file in Live pane"
          aria-label="Open file"
          onClick={() => void pickAndOpenDocuments(controller)}
        >
          <FilePlus size={13}/> Open file
        </button>
      </div>
      {openTabs.length > 0 && (
        <div className="hs-docs-list">
          {openTabs.map(tab => {
            const isDocActive = activeLeaves.some(l => l.item?.kind === 'doc' && l.item.path === tab.path);
            const isDirty = !!documents[tab.path]?.isDirty;
            return (
              <div key={tab.id} className={`hs-doc-row${isDocActive ? ' active' : ''}`}>
                <button
                  type="button"
                  className="hs-doc-row-btn"
                  title={tab.path}
                  onClick={() => {
                    lastSyncedPath.current = tab.path;
                    setActiveTab(tab.id);
                    controller.openItem({ kind: 'doc', path: tab.path });
                  }}
                >
                  <FileText size={13}/>
                  <span className="hs-doc-row-name">{getFileName(tab.path)}</span>
                  {isDirty && <span className="hs-doc-dirty" title="Unsaved changes">●</span>}
                </button>
                <button
                  type="button"
                  className="hs-doc-row-close"
                  aria-label={`Close ${getFileName(tab.path)}`}
                  title="Close document"
                  onClick={() => {
                    closeTabs([tab.id]);
                    controller.clearItemFromLayout(item => item.kind === 'doc' && item.path === tab.path);
                  }}
                >
                  <X size={11}/>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export const plugin = createPlugin({
  id: 'doc-pane',
  name: 'Document Panes',
  version: '1.0.0',
  description: 'Open, preview, and edit documents inside Live split panes.',
  setup(api) {
    api.registerPaneType({
      kind: 'doc',
      label: 'Document',
      renderTitle: ({ leafId, item, controller }) => {
        if (item.kind !== 'doc' || !('path' in item) || typeof item.path !== 'string') return null;
        return <DocPaneTitle leafId={leafId} path={item.path} controller={controller}/>;
      },
      renderBody: ({ item }) => {
        if (item.kind !== 'doc' || !('path' in item) || typeof item.path !== 'string') return null;
        return <DocPaneBody path={item.path}/>;
      },
    });

    api.registerSidebarSection({
      id: 'documents',
      order: 20,
      render: controller => <DocumentsSidebar controller={controller}/>,
    });

    api.registerEmptyAction({
      id: 'open-file',
      title: 'Open file',
      subtitle: 'Markdown, code, notes',
      order: 20,
      icon: <FilePlus size={15}/>,
      onClick: ({ leafId, controller }) => {
        void pickAndOpenDocuments(controller, leafId);
      },
    });
  },
});
