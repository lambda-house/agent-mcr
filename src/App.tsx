import React, { useEffect, useCallback, useMemo } from 'react';
import { defaultDocumentsLayout } from './store/documentsLayout';
import { useStore, panelShown, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, TOC_MIN_WIDTH, TOC_MAX_WIDTH, type ZoomPanel } from './store';
import { useReader } from './reader';
import { openPath, reader } from './readerHost';
import {
  CloseDocumentDialog, DocumentGroups, ReaderProvider, SaveAllDialog, allTabs, type RestoredDocument,
} from '@lambda-house/reader';
import { EmptyState } from '@lambda-house/ui';
import { FileQuestion } from 'lucide-react';
import { LayoutView, MainMenu, Shell, type Layout, type PaneType, type ShellSurface } from '@lambda-house/workbench';
import { Activity, FileText } from 'lucide-react';
import {
  isTauri,
  readFile,
  onMenuCommand,
  onAgentFilesChanged,
} from './utils/tauri';
import { appMenu, buildMenu, commandContext, menuCommands, commandForKey, useCommandContext } from './utils/commands';
import { getFileName } from '@lambda-house/reader';
import Toolbar, { ToolbarEnd } from './components/Toolbar';
import { flushEditorChanges } from '@lambda-house/reader';
import AgentPanel from './components/AgentPanel';
import TocSidebar from './components/TocSidebar';
import StatusBar from './components/StatusBar';
import SettingsModal from './components/SettingsModal';
import { agentFilesWatched, refreshAgentWorkspace } from './utils/agent';
import SessionWorkspace from './components/SessionWorkspace';
import { documentWindowPath } from './utils/documentWindow';

// ============================================================
// Main App Component
// ============================================================

// The window has two surfaces: Sessions (Live and Search), and Documents,
// which shows the agents' Markdown: instructions, rules, memory, plans and
// skills, by the folder their sessions work in. A memory reader window
// (`documentWindowPath`) is the Documents surface with one document.

/** Quiet time after the last agent file change before agent files are rescanned. */
const AGENT_CHANGE_DEBOUNCE = 500;
/** How often agent files are rescanned when they can't be watched (ms). */
const AGENT_POLL_INTERVAL = 10000;

/** Message of an Error or of a backend error ({ code, message }). */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

/**
 * Reload the open documents an outside program changed (unless they have
 * unsaved edits). Matched by file name: the watcher reports real paths, which
 * can differ from the path a document was opened under (symlinks, /private).
 */
async function reloadChangedDocuments(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const changed = new Set(names);
  const { documents, reloadDocument } = useReader.getState();
  await Promise.all(Object.values(documents)
    .filter((doc) => !doc.isDirty && changed.has(getFileName(doc.path)))
    .map(async (doc) => {
      try {
        reloadDocument(doc.path, await readFile(doc.path));
      } catch {
        // Removed or renamed: the tab keeps the last text
      }
    }));
}

/** An empty document group: how to open a document here. */
const NO_DOCUMENT = (
  <EmptyState size="lg" icon={<FileQuestion size={64} />} title="No Document Open">
    Select a document from the list on the left
  </EmptyState>
);

const App: React.FC = () => {
  // The shown surface is the store's: commands of the other one wait
  const surface = useStore((s) => s.surface);
  const setSurface = useStore((s) => s.setSurface);
  const sessionsVisible = surface === 'sessions';
  // Subscribe field by field so that high frequency updates (scroll offsets,
  // active heading) do not re-render the whole application.
  const documentsLayoutRoot = useStore((s) => s.documentsLayout);
  const setDocumentsLayout = useStore((s) => s.setDocumentsLayout);
  const agentEntries = useStore((s) => s.agentEntries);
  const hasAgentTabs = useReader((s) => allTabs(s).some((t) => agentEntries.some((e) => e.path === t.path)));

  const toggleTocVisible = useStore((s) => s.toggleTocVisible);
  const activateTabByIndex = useReader((s) => s.activateTabByIndex);
  const navigateBack = useReader((s) => s.navigateBack);
  const navigateForward = useReader((s) => s.navigateForward);
  const reopenClosedTab = useReader((s) => s.reopenClosedTab);
  const restoreSession = useReader((s) => s.restoreSession);
  const sessionRestored = useReader((s) => s.sessionRestored);

  // A memory reader window shows its one document and no list
  const filePanelVisible = panelShown({ documentsLayout: documentsLayoutRoot }, 'agent-docs') && !documentWindowPath;
  const documentsShown = !sessionsVisible;

  // Restore the previous session: the persisted tabs only carry paths, so the
  // documents behind them have to be re-read before the tabs become usable.
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      const persistedTabs = allTabs(useReader.getState());

      if (documentWindowPath || persistedTabs.length === 0 || !isTauri()) {
        restoreSession([]);
        return;
      }

      // A file open in two groups is read once
      const paths = [...new Set(persistedTabs.map((tab) => tab.path))];
      const results = await Promise.all(
        paths.map(async (path): Promise<RestoredDocument | null> => {
          try {
            return { path, content: await readFile(path) };
          } catch (error) {
            console.warn(`Dropping restored tab (cannot read ${path}):`, error);
            return null;
          }
        })
      );

      if (cancelled) return;
      restoreSession(results.filter((doc): doc is RestoredDocument => doc !== null));
    };

    restore();
    return () => {
      cancelled = true;
    };
  }, [restoreSession]);

  // Agent files change while agents work: rescan while their list or one of
  // them is on screen, when the backend reports a change and when the window
  // gets focus. Each scan also makes the backend look for new session folders.
  useEffect(() => {
    if (!isTauri() || documentWindowPath) return;
    if (!documentsShown || (!filePanelVisible && !hasAgentTabs)) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        refreshAgentWorkspace().catch((error) => console.error('Failed to refresh agent files:', error));
      }
    };
    refresh();
    // An agent writes several files in a row: rescan once they pause
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(refresh, AGENT_CHANGE_DEBOUNCE);
    };
    const unlisten = onAgentFilesChanged(scheduleRefresh);
    // The watcher couldn't start: poll instead
    const poll = setInterval(() => {
      if (!agentFilesWatched()) refresh();
    }, AGENT_POLL_INTERVAL);
    window.addEventListener('focus', refresh);
    return () => {
      clearTimeout(debounce);
      clearInterval(poll);
      unlisten.then((fn) => fn()).catch(() => {});
      window.removeEventListener('focus', refresh);
    };
  }, [documentsShown, filePanelVisible, hasAgentTabs]);

  // A native memory window opens only its requested document, independently of
  // the main window's launch queue and saved tabs.
  useEffect(() => {
    if (!documentWindowPath || !sessionRestored) return;
    void openPath(documentWindowPath).catch(error => alert(`Could not open memory:\n${errorText(error)}`));
    const refresh = () => {
      const names = Object.values(useReader.getState().documents).map(doc => getFileName(doc.path));
      void reloadChangedDocuments(names);
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [sessionRestored]);

  // Handle TOC toggle
  const handleToggleToc = useCallback(() => {
    toggleTocVisible();
  }, [toggleTocVisible]);

  const handleToggleFilePanel = useCallback(() => useStore.getState().togglePanel('agent-docs'), []);

  // Reopen closed tab
  const handleReopenClosedTab = useCallback(async () => {
    const closedTab = reopenClosedTab();
    if (closedTab) {
      try {
        await openPath(closedTab.path);
      } catch (error) {
        console.error('Failed to reopen file:', error);
      }
    }
  }, [reopenClosedTab, openPath]);
  
  // ============================================================
  // Keyboard Shortcuts
  // ============================================================
  
  // The commands, with their shortcuts, are defined in utils/commands.ts;
  // the toolbar's menu shows the same list
  const menu = useMemo(() => buildMenu({ reopenClosedTab: handleReopenClosedTab }), [handleReopenClosedTab]);

  // The command palette lists the same commands
  useEffect(() => appMenu.set(menu), [menu]);

  // The system menu uses the same commands as the toolbar menu.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onMenuCommand((id) => {
      const command = menuCommands(menu).find((item) => item.id === id);
      if (command && (!command.enabled || command.enabled(commandContext()))) command.run();
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => console.error('Failed to listen for menu commands:', error));
    return () => { disposed = true; unlisten?.(); };
  }, [menu]);

  useEffect(() => {
    const commands = menuCommands(menu);

    const handleKeyDown = (e: KeyboardEvent) => {
      // Already handled - e.g. by the editor (its own Ctrl+F search, Ctrl+S,
      // Alt+Left/Right word moves)
      if (e.defaultPrevented) return;

      const isMod = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;
      
      // Prevent default for our shortcuts
      const shouldPrevent = (
        (isMod && ['w', 'b', 'e', 's', 'f', '0', '=', '-'].includes(e.key.toLowerCase())) ||
        (isMod && isShift && ['o', 't', 'w'].includes(e.key.toLowerCase())) ||
        (isMod && e.key === 'Tab') ||
        (isMod && /^[1-9]$/.test(e.key))
      );
      
      if (shouldPrevent) {
        e.preventDefault();
      }
      
      const command = commandForKey(commands, e, useStore.getState().surface);
      if (command) {
        e.preventDefault();
        command.run();
        return;
      }
      
      // Ctrl/Cmd + 1-9: Go to tab by index
      if (isMod && /^[1-9]$/.test(e.key)) {
        const index = parseInt(e.key, 10) - 1;
        activateTabByIndex(index);
        return;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [menu, activateTabByIndex]);
  
  // ============================================================
  // Closing the window with unsaved edits asks first
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        return appWindow.onCloseRequested(async (event) => {
          const dirty = allTabs(useReader.getState()).filter((t) => t.isDirty);
          if (dirty.length === 0) return;
          event.preventDefault();
          const names = dirty.map((t) => t.title).join(', ');
          if (window.confirm(`Unsaved changes in ${names}. Close Agent MCR and discard them?`)) {
            await appWindow.destroy();
          }
        });
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => console.error('Failed to watch window close:', error));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Mouse back/forward buttons switch between tabs
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        navigateBack();
      } else if (e.button === 4) {
        e.preventDefault();
        navigateForward();
      }
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [navigateBack, navigateForward]);

  // Ctrl+wheel zooms the pane under the pointer: the workbench's LayoutView does it (each pane type's zoom)

  // ============================================================
  // Documents: the agent documents, the document groups and the contents,
  // on the workbench layout the store keeps (store/documentsLayout.ts). Its
  // handles and pane menus change it there. A memory window has no agent documents.
  // ============================================================

  const documentsLayout = useMemo<Layout>(() => ({ version: 1, root: documentsLayoutRoot }), [documentsLayoutRoot]);
  const applyDocumentsLayout = useCallback((next: Layout) => setDocumentsLayout(next.root), [setDocumentsLayout]);
  const resetDocumentsLayout = useCallback(() => setDocumentsLayout(defaultDocumentsLayout({ withAgentDocs: !documentWindowPath })), [setDocumentsLayout]);

  const documentPanes = useMemo<Record<string, PaneType>>(() => {
    const zoomOf = (panel: ZoomPanel) => ({
      get: () => useStore.getState().panelZoom[panel],
      step: (_: unknown, direction: 1 | -1 | 0) => useStore.getState().zoomPanel(panel, direction),
      subscribe: useStore.subscribe,
    });
    return {
      'agent-docs': {
        type: 'agent-docs', label: 'agent documents', title: 'Agent documents', singleton: true, collapsible: true,
        min: { w: PANEL_MIN_WIDTH }, max: { w: PANEL_MAX_WIDTH }, zoom: zoomOf('files'),
        render: () => <AgentPanel />,
      },
      documents: {
        type: 'documents', label: 'document', title: 'Documents', singleton: true, closable: false, keepAlive: true, min: { w: 200 },
        render: () => <DocumentGroups empty={NO_DOCUMENT} />,
      },
      contents: {
        type: 'contents', label: 'table of contents', title: 'Contents', singleton: true, collapsible: true,
        min: { w: TOC_MIN_WIDTH }, max: { w: TOC_MAX_WIDTH }, zoom: zoomOf('toc'),
        render: () => <TocSidebar onToggle={handleToggleToc} />,
      },
    };
  }, [handleToggleToc]);

  // The window's surfaces under one top bar (the workbench Shell). Documents is mounted only while shown;
  // Sessions stays mounted once opened. A memory window has Documents only.
  const surfaces: ShellSurface[] = [
    {
      id: 'documents', label: 'Documents', icon: <FileText size={13} />, keepMounted: false,
      render: () => (
        <>
          <Toolbar
            filePanelVisible={filePanelVisible}
            onToggleFilePanel={documentWindowPath ? undefined : handleToggleFilePanel}
          />

          <div className="main-content">
            <LayoutView layout={documentsLayout} onChange={applyDocumentsLayout} paneTypes={documentPanes} onReset={resetDocumentsLayout} />
          </div>

          <StatusBar />
        </>
      ),
    },
    ...(documentWindowPath ? [] : [{
      id: 'sessions', label: 'Sessions', icon: <Activity size={13} />,
      render: () => <SessionWorkspace active={sessionsVisible} />,
    }]),
  ];

  return (
    <ReaderProvider reader={reader}>
    <div className="app-container">
      <Shell
        surfaces={surfaces}
        active={surface}
        onActivate={setSurface}
        menu={<MainMenu items={menu} useCommandContext={useCommandContext} onOpen={flushEditorChanges} buttonClassName="toolbar-button" surface={surface} />}
        end={<ToolbarEnd />}
      />
      <SettingsModal />
      <SaveAllDialog />
      <CloseDocumentDialog />
    </div>
    </ReaderProvider>
  );
};

export default App;
