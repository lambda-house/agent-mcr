import React, { useEffect, useCallback } from 'react';
import { useStore, panelShown } from './store';
import { useReader } from './reader';
import { reader } from './readerHost';
import { allTabs, flushEditorChanges, readerPlugin } from '@lambda-house/reader';
import { journalPlugin } from '@lambda-house/journal';
import { Workbench } from '@lambda-house/workbench';
import { isTauri, onMenuCommand, onAgentFilesChanged } from './utils/tauri';
import { appMenu, buildMenu, commandContext, useCommandContext } from './utils/commands';
import { ToolbarEnd } from './components/Toolbar';
import MemoryConnection from './components/MemoryConnection';
import { journal } from './journal';
import { pluginRegistry } from './plugins';
import { agentFilesWatched, refreshAgentWorkspace } from './utils/agent';
import { documentWindowPath } from './utils/documentWindow';
import { NO_DOCUMENT, documentsPlugin, zoomOf } from './documents';

// ============================================================
// Agent MCR's window: the Workbench of its plugins (shared UI spec §3.3), the
// reader's, the journal's, Agent MCR's own (documents.tsx: Documents and
// Sessions) and the plugins in src/plugins, and what the window does through
// Tauri: rescanning agent files, closing with unsaved edits. A memory reader
// window (`documentWindowPath`) is the Documents surface with one document.
// ============================================================

/** Quiet time after the last agent file change before agent files are rescanned. */
const AGENT_CHANGE_DEBOUNCE = 500;
/** How often agent files are rescanned when they can't be watched (ms). */
const AGENT_POLL_INTERVAL = 10000;

const registry = pluginRegistry.workbench;
registry.register(readerPlugin(reader, {
  empty: NO_DOCUMENT,
  contents: { zoom: zoomOf('toc'), onClose: () => useStore.getState().toggleTocVisible() },
  // A memory window doesn't take the main window's tabs
  restore: isTauri() && !documentWindowPath,
  windowDocument: documentWindowPath,
}));
// Its view is a view of Sessions (SessionWorkspace); here its tabs, with the TEOB connection above the memories
registry.register(journalPlugin(journal, { memories: <MemoryConnection /> }));
registry.register(documentsPlugin);

// The commands, with their shortcuts, are in utils/commands.ts; the main
// menu, the keys, the native menu and the palette all read this one list
const menu = buildMenu();
appMenu.set(menu);

const setTheme = (theme: 'dark' | 'light') => {
  if (useStore.getState().theme !== theme) useStore.getState().toggleTheme();
};

const App: React.FC = () => {
  // The shown surface is the store's: commands of the other one wait
  const surface = useStore((s) => s.surface);
  const setSurface = useStore((s) => s.setSurface);
  const statusBarPinned = useStore((s) => s.statusBarPinned);
  const setStatusBarPinned = useStore((s) => s.setStatusBarPinned);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const closeSettings = useCallback(() => useStore.getState().setSettingsOpen(false), []);
  const theme = useStore((s) => s.theme);
  const agentEntries = useStore((s) => s.agentEntries);
  const hasAgentTabs = useReader((s) => allTabs(s).some((t) => agentEntries.some((e) => e.path === t.path)));
  // A memory reader window shows its one document and no list
  const filePanelVisible = useStore((s) => panelShown(s, 'agent-docs')) && !documentWindowPath;
  const documentsShown = surface !== 'sessions';

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

  return (
    <Workbench
      registry={registry}
      className="app-container"
      surface={surface}
      onSurface={setSurface}
      menu={menu}
      commandContext={commandContext}
      useCommandContext={useCommandContext}
      onMenuOpen={flushEditorChanges}
      menuButtonClassName="toolbar-button"
      nativeMenu={onMenuCommand}
      end={<ToolbarEnd />}
      status={{ pinned: statusBarPinned, onPinnedChange: setStatusBarPinned }}
      settings={{ open: settingsOpen, onClose: closeSettings }}
      appearance={{ theme, setTheme }}
    />
  );
};

export default App;
