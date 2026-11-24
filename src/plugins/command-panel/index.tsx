import { createPlugin } from '../sdk';
import { PaletteTrigger, sessionPaletteProvider } from '../../components/SessionPalette';

// The command panel: the sessions, the views and a few actions in the
// workbench's palette, which opens through the command app.commandPalette
// (its key, the Live sidebar's Search button, the menu). The palette works
// in Sessions only (App's `palette.enabled`), so over Documents its key stays free.
export const plugin = createPlugin({
  id: 'command-panel',
  name: 'Command Panel',
  version: '1.0.0',
  description: 'Quick session & action palette (Ctrl+Shift+P, or ⇧⌘P on macOS).',
  setup(api) {
    api.registerPaletteProvider(sessionPaletteProvider);
    api.registerSidebarSection({ id: 'command-panel', order: 0, render: () => <PaletteTrigger /> });
  },
});
