import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Kbd } from '@teob/ui';
import { createPlugin, pluginRegistry, type GlobalOverlayContext } from '../sdk';
import SessionCommandPanel from '../../components/SessionCommandPanel';

// The panel listens for Cmd+K itself; a second key listener here would toggle
// it twice per press and leave it closed. The sidebar button opens it by event.
function CommandPanelHost({ ctx }: { ctx: GlobalOverlayContext }) {
  const [open, setOpen] = useState(false);
  useEffect(() => pluginRegistry.onEvent('command-panel:open', () => setOpen(true)), []);
  return <SessionCommandPanel hideTrigger open={open} onOpenChange={setOpen} {...ctx}/>;
}

export const plugin = createPlugin({
  id: 'command-panel',
  name: 'Command Panel',
  version: '1.0.0',
  description: 'Quick session & action palette (Cmd+K / Ctrl+K).',
  setup(api) {
    api.registerGlobalOverlay({
      id: 'command-panel',
      order: 10,
      render: (ctx) => <CommandPanelHost key="command-panel" ctx={ctx} />,
    });
    api.registerSidebarSection({
      id: 'command-panel',
      order: 0,
      render: () => (
        <button type="button" className="cmd-trigger-btn" aria-keyshortcuts="Meta+K" title="Search sessions & commands (⌘K)" onClick={() => api.emitEvent('command-panel:open', {})}>
          <Search size={13} aria-hidden="true"/>
          <span className="cmd-trigger-btn__label">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
      ),
    });
  },
});
