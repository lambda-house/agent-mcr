import { createMenuStore, type Command as WorkbenchCommand, type MenuItem as WorkbenchMenuItem, type Submenu as WorkbenchSubmenu } from '@lambda-house/workbench';
import { useMemo } from 'react';
import { focusedGroupOf, readerCommands, type ReaderState } from '@lambda-house/reader';
import { journalCommands } from '@lambda-house/journal';
import { layoutCommands, zoomCommands } from '@lambda-house/workbench';
import { useStore, panelShown, type AppState } from '../store';
import { useReader } from '../reader';
import { reader } from '../readerHost';
import { journal } from '../journal';
import { liveNav } from './liveNav';
import { terminalTask, TASK_SHORTCUT } from './terminalTask';
import { PALETTE_SHORTCUT, PLATFORM } from './platform';

// The app's commands in one place: the main menu shows them (MainMenu.tsx)
// and the keyboard handler in App.tsx runs them, so a command, its place in
// the menu and its shortcut are defined once.

// ============================================================
// Commands: the types and helpers are the workbench's
// ============================================================

/** What a command's `enabled` and `checked` read: the app's state and the reader's. */
export type CommandContext = AppState & { reader: ReaderState };

export type Command = WorkbenchCommand<CommandContext>;
export type Submenu = WorkbenchSubmenu<CommandContext>;
export type MenuItem = WorkbenchMenuItem<CommandContext>;
export type { Shortcut } from '@lambda-house/workbench';
export { commandForKey, formatShortcut, isSubmenu, menuCommands } from '@lambda-house/workbench';

/** The menu App builds, for the command palette. */
export const appMenu = createMenuStore<CommandContext>();

/** The command context now (the native menu, the palette). */
export const commandContext = (): CommandContext => ({ ...useStore.getState(), reader: useReader.getState() });

/** The command context as a hook, for the main menu while it is open: re-renders on changes in either store. */
export function useCommandContext(): CommandContext {
  const app = useStore();
  const readerState = useReader((s) => s);
  return useMemo(() => ({ ...app, reader: readerState }), [app, readerState]);
}

/** The main menu, top to bottom: Agent MCR's commands, the reader's, the journal's and the workbench's. */
export function buildMenu(): MenuItem[] {
  const state = useStore.getState;
  const documents = useReader.getState;
  const setTheme = (theme: AppState['theme']) => {
    if (state().theme !== theme) state().toggleTheme();
  };
  /** Commands that act on what the Documents surface shows: they wait while Sessions is shown. */
  const onDocuments = (command: Command): Command => ({ ...command, surface: 'documents' });
  const doc = readerCommands(reader);
  const journalCmd = journalCommands(journal);
  const [splitPaneRight, splitPaneDown, closePane, focusNext, focusPrevious, resetLayout] = layoutCommands();
  // Zoom acts on the focused pane; before any pane had the focus, on the document
  const [zoomIn, zoomOut, resetZoom] = zoomCommands({
    get: () => focusedGroupOf(documents()).zoom,
    step: (direction) => (direction === 0 ? documents().resetZoom() : direction > 0 ? documents().zoomIn() : documents().zoomOut()),
  });

  return [
    onDocuments(doc.save),
    {
      label: 'Export As',
      items: [onDocuments(doc.exportMarkdown), onDocuments(doc.exportHtml)],
    },
    doc.saveAll,
    'separator',
    {
      label: 'View',
      items: [
        onDocuments({
          id: 'view.filePanel',
          label: 'Agent Documents',
          shortcut: { mod: true, key: 'b' },
          checked: (s) => panelShown(s, 'agent-docs'),
          run: () => state().togglePanel('agent-docs'),
        }),
        onDocuments({
          id: 'view.toc',
          label: 'Table of Contents',
          shortcut: { mod: true, shift: true, key: 'o' },
          checked: (s) => panelShown(s, 'contents'),
          run: () => state().toggleTocVisible(),
        }),
        {
          id: 'view.pinStatusBar',
          label: 'Pin Status Bar',
          checked: (s) => s.statusBarPinned,
          run: () => state().setStatusBarPinned(!state().statusBarPinned),
        },
        'separator',
        onDocuments(doc.splitRight),
        onDocuments(doc.splitDown),
        splitPaneRight,
        splitPaneDown,
        closePane,
        focusNext,
        focusPrevious,
        resetLayout,
        'separator',
        zoomIn,
        zoomOut,
        resetZoom,
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
        onDocuments(doc.editDocument),
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
        onDocuments(doc.find),
      ],
    },
    {
      label: 'Tabs',
      items: [
        onDocuments(doc.nextTab),
        onDocuments(doc.previousTab),
        // Through the Live view's history while it is shown, the document tabs' otherwise (MCR-108).
        // One command per key: the first command that matches a key is the one that runs
        {
          ...doc.back,
          aliases: PLATFORM === 'macos' ? [{ mod: true, key: '[' }] : [],
          enabled: (s) => liveNav.current ? liveNav.current.canBack() : doc.back.enabled?.(s) !== false,
          run: () => { if (liveNav.current) liveNav.current.back(); else doc.back.run(); },
        },
        {
          ...doc.forward,
          aliases: PLATFORM === 'macos' ? [{ mod: true, key: ']' }] : [],
          enabled: (s) => liveNav.current ? liveNav.current.canForward() : doc.forward.enabled?.(s) !== false,
          run: () => { if (liveNav.current) liveNav.current.forward(); else doc.forward.run(); },
        },
        'separator',
        onDocuments(doc.closeTab),
        onDocuments(doc.closeAllTabs),
        onDocuments(doc.reopenClosedTab),
      ],
    },
    {
      label: 'Journal',
      items: [{ ...journalCmd.refresh, surface: 'sessions' }, { ...journalCmd.newList, surface: 'sessions' }],
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
