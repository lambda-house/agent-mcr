// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlugin, pluginRegistry } from './index';

describe('plugin system', () => {
  afterEach(() => {
    pluginRegistry.unregister('test-plugin');
    localStorage.removeItem('agent-mcr:disabled-plugins');
  });

  it('auto-discovers built-in plugins', () => {
    const ids = pluginRegistry.listPlugins().map(p => p.id);
    expect(ids).toContain('command-panel');
    expect(pluginRegistry.getGlobalOverlays().some(o => o.id === 'command-panel')).toBe(true);
  });

  it('registers, toggles, and cleans up extension points and events', () => {
    const onSelected = vi.fn();
    const custom = createPlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      setup(api) {
        api.registerTopTab({ id: 'custom-tab', label: 'Custom', icon: null, render: () => null });
        api.registerPaneType({ kind: 'custom-pane', label: 'Custom', renderTitle: () => null, renderBody: () => null });
        api.registerSidebarSection({ id: 'custom-sec', render: () => null });
        api.registerEmptyAction({ id: 'custom-act', title: 'Act', subtitle: 'Sub', icon: null, onClick: () => {} });
        api.registerAppWrapper({ id: 'custom-wrap', wrap: (c) => c });
        api.registerGlobalOverlay({ id: 'custom-overlay', render: () => null });
        api.registerSettingsTab({ id: 'custom-settings', label: 'Custom', render: () => null });
        api.overrideComponent('live:empty-pane', ({ defaultRender }) => defaultRender());
        api.overrideComponent('live:sidebar', ({ defaultRender }) => defaultRender());
        api.overrideComponent('live:new-agent', ({ defaultRender }) => defaultRender());
        api.overrideComponent('live:layout-bar', ({ defaultRender }) => defaultRender());
        api.overrideComponent('live:session-header', ({ defaultRender }) => defaultRender());
        api.onEvent('session:selected', onSelected);
      },
    });

    pluginRegistry.register(custom);
    expect(pluginRegistry.getTopTabs().some(t => t.id === 'custom-tab')).toBe(true);
    expect(pluginRegistry.getPaneType('custom-pane')).toBeDefined();
    expect(pluginRegistry.getAppWrappers().some(w => w.id === 'custom-wrap')).toBe(true);
    expect(pluginRegistry.getGlobalOverlays().some(o => o.id === 'custom-overlay')).toBe(true);
    expect(pluginRegistry.getSettingsTabs().some(t => t.id === 'custom-settings')).toBe(true);
    expect(pluginRegistry.getOverride('live:empty-pane')).toBeDefined();

    pluginRegistry.emitEvent('session:selected', { id: 's42' });
    expect(onSelected).toHaveBeenCalledWith({ id: 's42' });

    pluginRegistry.setEnabled('test-plugin', false);
    expect(pluginRegistry.isEnabled('test-plugin')).toBe(false);
    expect(pluginRegistry.getTopTabs().some(t => t.id === 'custom-tab')).toBe(false);
    expect(pluginRegistry.getPaneType('custom-pane')).toBeUndefined();
    expect(pluginRegistry.getAppWrappers().some(w => w.id === 'custom-wrap')).toBe(false);
    expect(pluginRegistry.getGlobalOverlays().some(o => o.id === 'custom-overlay')).toBe(false);
    expect(pluginRegistry.getSettingsTabs().some(t => t.id === 'custom-settings')).toBe(false);
    expect(pluginRegistry.getOverride('live:empty-pane')).toBeUndefined();

    onSelected.mockClear();
    pluginRegistry.emitEvent('session:selected', { id: 's43' });
    expect(onSelected).not.toHaveBeenCalled();

    pluginRegistry.setEnabled('test-plugin', true);
    expect(pluginRegistry.getTopTabs().some(t => t.id === 'custom-tab')).toBe(true);
  });
});
