import React, { useEffect, useCallback, useMemo, useState } from 'react';
import { useStore, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, TOC_MIN_WIDTH, TOC_MAX_WIDTH, type Heading, type RestoredDocument } from './store';
import { LayoutView, findLeaf, isPx, type Layout, type LayoutNode, type PaneType, type Size } from '@lambda-house/workbench';
import {
  isTauri,
  readFile,
  onMenuCommand,
  openExternal,
  followLocalLink,
  onAgentFilesChanged,
} from './utils/tauri';
import { appMenu, buildMenu, menuCommands, commandForKey } from './utils/commands';
import { getFileName, resolveLinkPath } from './utils/files';
import Toolbar from './components/Toolbar';
import AgentPanel from './components/AgentPanel';
import DocumentPanel from './components/DocumentPanel';
import TocSidebar from './components/TocSidebar';
import StatusBar from './components/StatusBar';
import SettingsModal from './components/SettingsModal';
import SaveAllDialog from './components/SaveAllDialog';
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
  const { documents, reloadDocument } = useStore.getState();
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

const App: React.FC = () => {
  const [sessionsVisible, setSessionsVisible] = useState(!documentWindowPath);
  const [sessionsMounted, setSessionsMounted] = useState(sessionsVisible);
  // Subscribe field by field so that high frequency updates (scroll offsets,
  // active heading) do not re-render the whole application.
  const panelWidth = useStore((s) => s.panelWidth);
  const tocWidth = useStore((s) => s.tocWidth);
  const tocVisible = useStore((s) => s.tocVisible);
  const hasAgentTabs = useStore((s) => s.tabs.some((t) => s.agentEntries.some((e) => e.path === t.path)));

  const setPanelWidth = useStore((s) => s.setPanelWidth);
  const setTocWidth = useStore((s) => s.setTocWidth);
  const toggleTocVisible = useStore((s) => s.toggleTocVisible);
  const activateTabByIndex = useStore((s) => s.activateTabByIndex);
  const navigateBack = useStore((s) => s.navigateBack);
  const navigateForward = useStore((s) => s.navigateForward);
  const zoomIn = useStore((s) => s.zoomIn);
  const zoomOut = useStore((s) => s.zoomOut);
  const zoomPanel = useStore((s) => s.zoomPanel);
  const reopenClosedTab = useStore((s) => s.reopenClosedTab);
  const openDocument = useStore((s) => s.openDocument);
  const restoreSession = useStore((s) => s.restoreSession);
  const sessionRestored = useStore((s) => s.sessionRestored);

  const [headings, setHeadings] = useState<Heading[]>([]);
  // A memory reader window shows its one document and no list
  const filePanelVisible = useStore((s) => s.filePanelVisible) && !documentWindowPath;
  const setFilePanelVisible = useStore((s) => s.setFilePanelVisible);
  const setTocVisible = useStore((s) => s.setTocVisible);
  const documentsShown = !sessionsVisible;

  // Restore the previous session: the persisted tabs only carry paths, so the
  // documents behind them have to be re-read before the tabs become usable.
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      const persistedTabs = useStore.getState().tabs;

      if (documentWindowPath || persistedTabs.length === 0 || !isTauri()) {
        restoreSession([]);
        return;
      }

      const results = await Promise.all(
        persistedTabs.map(async (tab): Promise<RestoredDocument | null> => {
          try {
            return { path: tab.path, content: await readFile(tab.path) };
          } catch (error) {
            console.warn(`Dropping restored tab (cannot read ${tab.path}):`, error);
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

  // Open a document by path (links, reopened tabs, the memory reader window)
  const openPath = useCallback(async (path: string, options?: { preview?: boolean }) => {
    const content = await readFile(path);
    const result = openDocument(path, content, options);

    if (!result.success) {
      throw new Error(result.error || 'Failed to open document');
    }
  }, [openDocument]);

  // A native memory window opens only its requested document, independently of
  // the main window's launch queue and saved tabs.
  useEffect(() => {
    if (!documentWindowPath || !sessionRestored) return;
    void openPath(documentWindowPath).catch(error => alert(`Could not open memory:\n${errorText(error)}`));
    const refresh = () => {
      const names = Object.values(useStore.getState().documents).map(doc => getFileName(doc.path));
      void reloadChangedDocuments(names);
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [sessionRestored, openPath]);

  // Links in the document. The window itself never navigates (the backend
  // blocks it): anchors scroll, web/mail links open in the default browser,
  // links to local files open in a tab (or are revealed if not viewable),
  // after a native confirmation when they're outside what the user opened.
  useEffect(() => {
    const handleClick = async (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const link = (e.target as HTMLElement).closest?.('.document-panel .markdown-body a[href]');
      if (!link) return;
      const href = link.getAttribute('href') ?? '';
      e.preventDefault();

      if (href.startsWith('#')) {
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // Malformed escape: use the id as written
        }
        link.closest('.markdown-body')?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth' });
        return;
      }

      try {
        if (/^(https?|mailto):/i.test(href)) {
          await openExternal(href);
          return;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) {
          return; // other schemes (javascript:, data:, ...) are ignored
        }

        const { tabs, activeTabId } = useStore.getState();
        const documentPath = tabs.find((tab) => tab.id === activeTabId)?.path;
        if (!documentPath) return;
        const path = resolveLinkPath(href, documentPath);
        if ((await followLocalLink(path)) === 'open') {
          await openPath(path);
        }
      } catch (error) {
        console.error('Failed to open link:', href, error);
        alert(`Could not open ${href}:\n${errorText(error)}`);
      }
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [openPath]);

  // Handle headings change from document
  const handleHeadingsChange = useCallback((newHeadings: Heading[]) => {
    setHeadings(newHeadings);
  }, []);

  // Handle TOC toggle
  const handleToggleToc = useCallback(() => {
    toggleTocVisible();
  }, [toggleTocVisible]);

  const handleToggleFilePanel = useCallback(() => {
    setFilePanelVisible(!useStore.getState().filePanelVisible);
  }, [setFilePanelVisible]);

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
      if (command && (!command.enabled || command.enabled(useStore.getState()))) command.run();
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
      
      const command = commandForKey(commands, e);
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
          const dirty = useStore.getState().tabs.filter((t) => t.isDirty);
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

  // Ctrl+Scroll for zoom
  // ============================================================
  
  // Zooms whatever is under the cursor: the file panel and the TOC have their
  // own zoom, everywhere else it is the document zoom.
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.deltaY === 0) return;
      e.preventDefault();

      const direction = e.deltaY < 0 ? 1 : -1;
      const panel = (e.target as Element | null)
        ?.closest?.('[data-zoom-panel]')
        ?.getAttribute('data-zoom-panel');

      if (panel === 'files' || panel === 'toc') {
        zoomPanel(panel, direction);
      } else if (direction > 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    };
    
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [zoomIn, zoomOut, zoomPanel]);

  // ============================================================
  // Documents: the agent documents, the document and the contents on the
  // workbench layout, drawn from the store's widths and flags; what the
  // handles change goes back through the same setters. A memory window has
  // the left panel only while it is shown, as before.
  // ============================================================

  const documentsLayout = useMemo<Layout>(() => {
    const children: LayoutNode[] = [
      { kind: 'leaf', id: 'main', pane: { type: 'documents', key: 'main' } },
      { kind: 'leaf', id: 'right', pane: { type: 'contents', key: 'contents' }, collapsed: !tocVisible },
    ];
    const sizes: Size[] = [{ fr: 1 }, { px: tocWidth }];
    if (!documentWindowPath || filePanelVisible) {
      children.unshift({ kind: 'leaf', id: 'left', pane: { type: 'agent-docs', key: 'left' }, collapsed: !filePanelVisible });
      sizes.unshift({ px: panelWidth });
    }
    return { version: 1, root: { kind: 'split', id: 'documents', dir: 'row', children, sizes } };
  }, [filePanelVisible, tocVisible, panelWidth, tocWidth]);

  const applyDocumentsLayout = useCallback((next: Layout) => {
    const split = next.root.kind === 'split' ? next.root : null;
    const width = (id: string) => {
      const size = split?.sizes[split.children.findIndex((child) => child.id === id)];
      return size && isPx(size) ? size.px : undefined;
    };
    const left = findLeaf(next.root, 'left');
    const right = findLeaf(next.root, 'right');
    if (left && !left.collapsed !== filePanelVisible) setFilePanelVisible(!left.collapsed);
    if (right && !right.collapsed !== tocVisible) setTocVisible(!right.collapsed);
    const leftWidth = width('left'), rightWidth = width('right');
    if (leftWidth !== undefined && leftWidth !== panelWidth) setPanelWidth(leftWidth);
    if (rightWidth !== undefined && rightWidth !== tocWidth) setTocWidth(rightWidth);
  }, [filePanelVisible, tocVisible, panelWidth, tocWidth, setFilePanelVisible, setTocVisible, setPanelWidth, setTocWidth]);

  const documentPanes = useMemo<Record<string, PaneType>>(() => ({
    'agent-docs': {
      type: 'agent-docs', label: 'agent documents', collapsible: true, min: { w: PANEL_MIN_WIDTH }, max: { w: PANEL_MAX_WIDTH },
      render: () => <AgentPanel width={panelWidth} />,
    },
    documents: { type: 'documents', label: 'document', min: { w: 200 }, render: () => <DocumentPanel onHeadingsChange={handleHeadingsChange} /> },
    contents: {
      type: 'contents', label: 'table of contents', collapsible: true, min: { w: TOC_MIN_WIDTH }, max: { w: TOC_MAX_WIDTH },
      render: () => <TocSidebar headings={headings} width={tocWidth} isVisible={tocVisible} onToggle={handleToggleToc} />,
    },
  }), [panelWidth, tocWidth, tocVisible, headings, handleHeadingsChange, handleToggleToc]);

  return (
    <div className="app-container">
      <div className="workspace-surface" hidden={!sessionsVisible}>
        {sessionsMounted && <SessionWorkspace active={sessionsVisible} onClose={() => setSessionsVisible(false)} />}
      </div>
      {!sessionsVisible && <div className="workspace-surface">
      <Toolbar
        menu={menu}
        onOpenSessions={documentWindowPath ? undefined : () => { setSessionsMounted(true); setSessionsVisible(true); }}
        filePanelVisible={filePanelVisible}
        onToggleFilePanel={documentWindowPath ? undefined : handleToggleFilePanel}
      />

      <div className="main-content">
        <LayoutView layout={documentsLayout} onChange={applyDocumentsLayout} paneTypes={documentPanes} />
      </div>

      <StatusBar />
      </div>}
      <SettingsModal />
      <SaveAllDialog />
    </div>
  );
};

export default App;
