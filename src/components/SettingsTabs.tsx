import React, { useEffect, useState } from 'react';
import { Info, Puzzle, Terminal } from 'lucide-react';
import { SettingRow } from '@lambda-house/ui';
import { SettingsSection, type SettingsTab } from '@lambda-house/workbench';
import { getAppVersion } from '../utils/tauri';
import { pluginRegistry } from '../plugins';
import HarnessSettingsSection from './HarnessSettingsSection';

// Agent MCR's own tabs in the workbench's Settings dialog: about, the
// harnesses, and what plugins add. The reader, the journal and the workbench bring theirs.

const About: React.FC = () => {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { getAppVersion().then(setVersion).catch(() => {}); }, []);
  return (
    <SettingsSection title="About">
      <div className="settings-card">
        <SettingRow
          label="Version"
          description={`${version ? `Agent MCR ${version}. ` : ''}The app does not update itself and does not look for new versions.`}
          control={null}
        />
      </div>
    </SettingsSection>
  );
};

export function appSettingsTabs(): SettingsTab[] {
  return [
    { id: 'about', label: 'About', icon: <Info size={15} />, group: 'Application', order: 90, render: () => <About /> },
    { id: 'harnesses', label: 'Harnesses', icon: <Terminal size={15} />, group: 'Workspace & Agent', order: 70, render: () => <HarnessSettingsSection /> },
    ...pluginRegistry.getSettingsTabs().map((tab, index): SettingsTab => ({
      id: tab.id, label: tab.label, icon: tab.icon ?? <Puzzle size={15} />, group: tab.group ?? 'Workspace & Agent', order: tab.order ?? 100 + index, render: tab.render,
    })),
  ];
}
