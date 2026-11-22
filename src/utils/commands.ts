import { createMenuStore, type Command as WorkbenchCommand, type MenuItem as WorkbenchMenuItem, type Submenu as WorkbenchSubmenu } from '@lambda-house/workbench';
import { useStore, canNavigateBack, canNavigateForward, type AppState } from '../store';
import { liveNav } from './liveNav';
import { terminalTask, TASK_SHORTCUT } from './terminalTask';
import { PALETTE_SHORTCUT, PLATFORM } from './platform';
import { saveActiveDocument, requestSaveAll } from './save';
import { exportActiveDocument } from './export';

// The app's commands in one place: the main menu shows them (MainMenu.tsx)
// and the keyboard handler in App.tsx runs them, so a command, its place in
// the menu and its shortcut are defined once.

// ============================================================
// Commands: the types and helpers are the workbench's
// ============================================================

export type Command = WorkbenchCommand<AppState>;
export type Submenu = WorkbenchSubmenu<AppState>;
export type MenuItem = WorkbenchMenuItem<AppState>;
export type { Shortcut } from '@lambda-house/workbench';
export { commandForKey, formatShortcut, isSubmenu, menuCommands } from '@lambda-house/workbench';

/** The menu App builds, for the command palette. */
export const appMenu = createMenuStore<AppState>();

/** What the commands need from the app shell (App.tsx); the rest is in the store. */
export interface MenuActions {
  reopenClosedTab: () => void;
}

/** Single-line selected text, to seed find/search (undefined keeps the old query). */
function getSelectedText(): string | undefined {
  const text = window.getSelection()?.toString().trim();
  return text && !text.includes('\n') && text.length <= 200 ? text : undefined;
}

const activeTab = (state: AppState) => state.tabs.find((t) => t.id === state.activeTabId);
const hasDocument = (state: AppState) => activeTab(state) !== undefined;
const hasSeveralTabs = (state: AppState) => state.tabs.length > 1;

/** The main menu, top to bottom. */
export function buildMenu(actions: MenuActions): MenuItem[] {
  const state = useStore.getState;
  const setTheme = (theme: AppState['theme']) => {
    if (state().theme !== theme) state().toggleTheme();
  };

  return [
    {
      id: 'file.save',
      label: 'Save File',
      shortcut: { mod: true, key: 's' },
      enabled: (s) => activeTab(s)?.isDirty === true,
      run: () => { saveActiveDocument(); },
    },
    {
      label: 'Export As',
      items: [
        {
          id: 'file.exportMarkdown',
          label: 'Markdown…',
          enabled: hasDocument,
          run: () => { exportActiveDocument('markdown'); },
        },
        {
          id: 'file.exportHtml',
          label: 'HTML…',
          enabled: hasDocument,
          run: () => { exportActiveDocument('html'); },
        },
      ],
    },
    {
      id: 'file.saveAll',
      label: 'Save All…',
      shortcut: { mod: true, shift: true, key: 's' },
      enabled: (s) => s.tabs.some((t) => t.isDirty),
      run: requestSaveAll,
    },
    'separator',
    {
      label: 'View',
      items: [
        {
          id: 'view.filePanel',
          label: 'Agent Documents',
          shortcut: { mod: true, key: 'b' },
          checked: (s) => s.filePanelVisible,
          run: () => state().setFilePanelVisible(!state().filePanelVisible),
        },
        {
          id: 'view.toc',
          label: 'Table of Contents',
          shortcut: { mod: true, shift: true, key: 'o' },
          checked: (s) => s.tocVisible,
          run: () => state().toggleTocVisible(),
        },
        {
          id: 'view.pinStatusBar',
          label: 'Pin Status Bar',
          checked: (s) => s.statusBarPinned,
          run: () => {
            const pinned = !state().statusBarPinned;
            state().setStatusBarPinned(pinned);
            if (pinned) state().setStatusBarVisible(true);
          },
        },
        'separator',
        {
          id: 'view.zoomIn',
          label: 'Zoom In',
          shortcut: { mod: true, key: '+' },
          aliases: [{ mod: true, key: '=' }],
          run: () => state().zoomIn(),
        },
        {
          id: 'view.zoomOut',
          label: 'Zoom Out',
          shortcut: { mod: true, key: '-' },
          run: () => state().zoomOut(),
        },
        {
          id: 'view.resetZoom',
          label: 'Reset Zoom',
          shortcut: { mod: true, key: '0' },
          enabled: (s) => s.zoom !== 100,
          run: () => state().resetZoom(),
        },
        'separator',
        {
          id: 'view.darkTheme',
          label: 'Dark Theme',
          checked: (s) => s.theme === 'dark',
          run: () => setTheme('dark'),
        },
        {
          id: 'view.lightTheme',
          label: 'Light Theme',
          checked: (s) => s.theme === 'light',
          run: () => setTheme('light'),
        },
      ],
    },
    {
      label: 'Edit',
      items: [
        {
          id: 'edit.editDocument',
          label: 'Edit Document',
          shortcut: { mod: true, key: 'e' },
          checked: (s) => s.editMode,
          run: () => state().toggleEditMode(),
        },
        // MCR-125 v0: the passage selected in the terminal that last had the keyboard,
        // with the operator's instruction, as a task text on the clipboard
        {
          id: 'edit.copyAsTask',
          label: 'Copy Terminal Selection as Task…',
          // macOS only: elsewhere Ctrl+Shift+C is the terminal's copy
          shortcut: PLATFORM === 'macos' ? { ...TASK_SHORTCUT } : undefined,
          enabled: () => terminalTask.current?.hasSelection() ?? false,
          run: () => terminalTask.current?.open(),
        },
      ],
    },
    {
      label: 'Search',
      items: [
        {
          // The command panel is a global overlay of Sessions: over Documents its key stays free
          id: 'app.commandPalette',
          label: 'Command Panel…',
          shortcut: { ...PALETTE_SHORTCUT },
          palette: false,
          enabled: (s) => s.paletteHosted,
          run: () => { if (state().paletteHosted) state().setPaletteOpen(true); },
        },
        {
          id: 'search.find',
          label: 'Find in Document…',
          shortcut: { mod: true, key: 'f' },
          enabled: hasDocument,
          run: () => state().openFind(getSelectedText()),
        },
      ],
    },
    {
      label: 'Tabs',
      items: [
        {
          id: 'tabs.next',
          label: 'Next Tab',
          shortcut: { ctrl: true, key: 'Tab' },
          enabled: hasSeveralTabs,
          run: () => state().activateNextTab(),
        },
        {
          id: 'tabs.previous',
          label: 'Previous Tab',
          shortcut: { ctrl: true, shift: true, key: 'Tab' },
          enabled: hasSeveralTabs,
          run: () => state().activatePrevTab(),
        },
        // Through the Live view's history while it is shown, the document tabs' otherwise (MCR-108).
        // One command per key: the first command that matches a key is the one that runs
        {
          id: 'tabs.back',
          label: 'Back',
          shortcut: { alt: true, key: 'ArrowLeft' },
          aliases: PLATFORM === 'macos' ? [{ mod: true, key: '[' }] : [],
          enabled: (s) => liveNav.current ? liveNav.current.canBack() : canNavigateBack(s),
          run: () => { if (liveNav.current) liveNav.current.back(); else state().navigateBack(); },
        },
        {
          id: 'tabs.forward',
          label: 'Forward',
          shortcut: { alt: true, key: 'ArrowRight' },
          aliases: PLATFORM === 'macos' ? [{ mod: true, key: ']' }] : [],
          enabled: (s) => liveNav.current ? liveNav.current.canForward() : canNavigateForward(s),
          run: () => { if (liveNav.current) liveNav.current.forward(); else state().navigateForward(); },
        },
        'separator',
        {
          id: 'tabs.close',
          label: 'Close Tab',
          shortcut: { mod: true, key: 'w' },
          enabled: hasDocument,
          run: () => {
            const tabId = state().activeTabId;
            if (tabId) state().closeDocument(tabId);
          },
        },
        {
          id: 'tabs.closeAll',
          // Unsaved ones are kept
          label: 'Close All Tabs',
          shortcut: { mod: true, shift: true, key: 'w' },
          enabled: (s) => s.tabs.length > 0,
          run: () => {
            const result = state().closeAllTabs();
            if (!result.success && result.error) alert(result.error);
          },
        },
        {
          id: 'tabs.reopen',
          label: 'Reopen Closed Tab',
          shortcut: { mod: true, shift: true, key: 't' },
          enabled: (s) => s.recentlyClosed.length > 0,
          run: actions.reopenClosedTab,
        },
      ],
    },
    'separator',
    {
      id: 'app.settings',
      label: 'Settings…',
      shortcut: { mod: true, key: ',' },
      run: () => state().setSettingsOpen(true),
    },
  ];
}
