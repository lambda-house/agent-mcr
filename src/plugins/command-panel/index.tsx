import { useState } from 'react';
import { createPlugin, type GlobalOverlayContext } from '../sdk';
import SessionCommandPanel from '../../components/SessionCommandPanel';

// The panel listens for Cmd+K itself; a second listener here would toggle it
// twice per key press and leave it closed.
function CommandPanelHost({ ctx }: { ctx: GlobalOverlayContext }) {
  const [open, setOpen] = useState(false);
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
  },
});
