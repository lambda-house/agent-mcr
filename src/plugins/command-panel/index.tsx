import { useEffect } from 'react';
import { Search } from 'lucide-react';
import { Kbd } from '@lambda-house/ui';
import { paletteShortcut, PLATFORM } from '../../utils/platform';
import { createPlugin, type GlobalOverlayContext } from '../sdk';
import { useStore } from '../../store';
import SessionCommandPanel from '../../components/SessionCommandPanel';

// The panel opens through the command app.commandPalette (its key, the sidebar's button, the menu) and the
// store's paletteOpen. It is mounted in Sessions only, so over Documents the key stays free: while it is
// mounted, paletteHosted tells the command it is there.
function CommandPanelHost({ ctx }: { ctx: GlobalOverlayContext }) {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const setHosted = useStore((s) => s.setPaletteHosted);
  useEffect(() => {
    setHosted(true);
    return () => { setHosted(false); setOpen(false); };
  }, [setHosted, setOpen]);
  return <SessionCommandPanel hideTrigger open={open} onOpenChange={setOpen} {...ctx}/>;
}

export const plugin = createPlugin({
  id: 'command-panel',
  name: 'Command Panel',
  version: '1.0.0',
  description: 'Quick session & action palette (Ctrl+Shift+P, or ⇧⌘P on macOS).',
  setup(api) {
    api.registerGlobalOverlay({
      id: 'command-panel',
      order: 10,
      render: (ctx) => <CommandPanelHost key="command-panel" ctx={ctx} />,
    });
    api.registerSidebarSection({
      id: 'command-panel',
      order: 0,
      render: () => {
        const shortcut = paletteShortcut(PLATFORM);
        return (
        <button type="button" className="cmd-trigger-btn" aria-keyshortcuts={shortcut.aria} title={`Search sessions & commands (${shortcut.label})`} onClick={() => useStore.getState().setPaletteOpen(true)}>
          <Search size={13} aria-hidden="true"/>
          <span className="cmd-trigger-btn__label">Search</span>
          <Kbd>{shortcut.label}</Kbd>
        </button>
        );
      },
    });
  },
});
