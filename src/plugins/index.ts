import { pluginRegistry, type McrPlugin } from './sdk';

let loaded = false;

export function ensurePluginsLoaded(): void {
  if (loaded) return;
  loaded = true;
  const modules = import.meta.glob<{ plugin?: McrPlugin; default?: McrPlugin }>(
    ['./*/index.ts', './*/index.tsx'],
    { eager: true },
  );
  for (const mod of Object.values(modules)) {
    const plugin = mod.plugin ?? mod.default;
    if (plugin && typeof plugin.id === 'string' && typeof plugin.setup === 'function') {
      pluginRegistry.register(plugin);
    }
  }
}

ensurePluginsLoaded();

export { pluginRegistry, createPlugin } from './sdk';
export { usePluginVersion } from './usePlugins';
export type {
  McrPlugin,
  PluginApi,
  TopTabPlugin,
  PaneTypePlugin,
  SidebarSectionPlugin,
  EmptyActionPlugin,
  SessionEnricher,
  LiveControllerContext,
  PaneRenderContext,
  AppWrapperPlugin,
  GlobalOverlayContext,
  GlobalOverlayPlugin,
  SettingsTabPlugin,
  PluginEventName,
  PluginEventMap,
} from './sdk';
