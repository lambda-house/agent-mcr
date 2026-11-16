import { useEffect, useState } from 'react';
import { createPlugin, pluginRegistry, type GlobalOverlayContext } from '../sdk';
import SessionCommandPanel from '../../components/SessionCommandPanel';

function CommandPanelHost({ ctx }: { ctx: GlobalOverlayContext }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const off = pluginRegistry.onEvent('command-panel:open', () => setOpen(true));
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      off();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <SessionCommandPanel
      hideTrigger
      open={open}
      onOpenChange={setOpen}
      enabled={ctx.enabled}
      sessions={ctx.sessions}
      directory={ctx.directory}
      onClearDirectory={ctx.onClearDirectory}
      onSelectSession={ctx.onSelectSession}
      onNavigateView={ctx.onNavigateView}
      onOpenSettings={ctx.onOpenSettings}
      onRefresh={ctx.onRefresh}
      onEnableAccess={ctx.onEnableAccess}
      topTabs={ctx.topTabs}
    />
  );
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
