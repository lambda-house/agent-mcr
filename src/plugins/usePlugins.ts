import { usePlugins } from '@lambda-house/workbench';
import { pluginRegistry } from './sdk';

/** Re-renders when plugins come, go or are turned on or off. */
export function usePluginVersion(): number {
  return usePlugins(pluginRegistry.workbench);
}
