import { useEffect, useState } from 'react';
import { pluginRegistry } from './sdk';

export function usePluginVersion(): number {
  const [ver, setVer] = useState(0);
  useEffect(() => pluginRegistry.subscribe(() => setVer(v => v + 1)), []);
  return ver;
}
