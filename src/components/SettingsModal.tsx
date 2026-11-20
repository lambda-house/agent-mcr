import React, { useCallback, useEffect, useState } from 'react';
import {
  X,
  Settings,
  Database,
  Shield,
  Puzzle,
  FileText,
  Terminal,
} from 'lucide-react';
import { Badge, Button, Kbd, Notice, SettingRow } from '@/ui';
import { useStore } from '../store';
import { getAppVersion } from '../utils/tauri';
import { pluginRegistry, usePluginVersion } from '../plugins';
import SessionMemoryBrowser from './SessionMemoryBrowser';
import SessionAgentAccess from './SessionAgentAccess';
import HarnessSettingsSection from './HarnessSettingsSection';
import MemoryConnection from './MemoryConnection';
import '../styles/settings-modal.css';

type SettingsCategory =
  | 'general'
  | 'plugins'
  | 'memories'
  | 'agent-access'
  | (string & {});

function pluginIcon(id: string) {
  if (id === 'doc-pane') return <FileText size={16} />;
  return <Puzzle size={16} />;
}

function PluginsSettingsSection() {
  usePluginVersion();
  const plugins = pluginRegistry.listPlugins();
  const enabledCount = plugins.filter((p) => p.enabled).length;

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <div className="settings-section-title-row">
          <h3>Plugins</h3>
          {plugins.length > 0 && (
            <Badge tone="neutral">{`${enabledCount} / ${plugins.length} active`}</Badge>
          )}
        </div>
        <p className="settings-section-description">
          Enable or disable built-in and local plugins. Changes apply immediately without restarting.
        </p>
      </div>

      {plugins.length === 0 ? (
        <div className="settings-card settings-card--padded">
          <p className="settings-section-description">No plugins registered.</p>
        </div>
      ) : (
        <div className="settings-plugin-list">
          {plugins.map((plugin) => (
            <div
              key={plugin.id}
              className={`settings-plugin-card ${plugin.enabled ? 'is-enabled' : 'is-disabled'}`}
            >
              <div className="settings-plugin-icon" aria-hidden="true">
                {pluginIcon(plugin.id)}
              </div>
              <div className="settings-plugin-body">
                <div className="settings-plugin-title">
                  <span className="settings-plugin-name">{plugin.name}</span>
                  {plugin.version && <Badge tone="neutral">{`v${plugin.version}`}</Badge>}
                  <Badge tone={plugin.enabled ? 'ok' : 'neutral'} dot>
                    {plugin.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                  <span className="settings-plugin-id">{plugin.id}</span>
                </div>
                {plugin.description && (
                  <p className="settings-plugin-desc">{plugin.description}</p>
                )}
              </div>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  aria-label={`Toggle ${plugin.name}`}
                  checked={plugin.enabled}
                  onChange={(e) => pluginRegistry.setEnabled(plugin.id, e.target.checked)}
                />
                <span className="settings-toggle-slider" />
              </label>
            </div>
          ))}
        </div>
      )}

      <Notice tone="info" title="Local plugins">
        Plugins are auto-discovered from <code>src/plugins/*/index.ts(x)</code>.
      </Notice>
    </div>
  );
}

const SettingsModal: React.FC = () => {
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const smoothScroll = useStore((s) => s.smoothScroll);
  const setSmoothScroll = useStore((s) => s.setSmoothScroll);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  usePluginVersion();
  const pluginSettingsTabs = pluginRegistry.getSettingsTabs();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('general');

  useEffect(() => {
    getAppVersion().then(setAppVersion).catch(() => {});
  }, []);

  const handleClose = useCallback(() => {
    setSettingsOpen(false);
  }, [setSettingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [settingsOpen, handleClose]);

  if (!settingsOpen) {
    return null;
  }

  return (
    <div className="modal-overlay settings-overlay" onClick={handleClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <div className="settings-header-title">
            <h2>Settings</h2>
          </div>
          <div className="settings-header-actions">
            <Kbd>Esc</Kbd>
            <Button
              variant="ghost"
              size="sm"
              className="settings-close"
              onClick={handleClose}
              title="Close (Escape)"
              aria-label="Close settings"
              icon={<X size={15} />}
            />
          </div>
        </div>

        <div className="settings-content">
          <nav className="settings-sidebar" aria-label="Settings sections">
            <div className="settings-nav-group">Application</div>
            <button
              type="button"
              className={`settings-nav-item ${activeCategory === 'general' ? 'active' : ''}`}
              onClick={() => setActiveCategory('general')}
            >
              <Settings size={15} />
              <span>General</span>
            </button>
            <button
              type="button"
              className={`settings-nav-item ${activeCategory === 'plugins' ? 'active' : ''}`}
              onClick={() => setActiveCategory('plugins')}
            >
              <Puzzle size={15} />
              <span>Plugins</span>
            </button>

            <div className="settings-nav-group">Workspace &amp; Agent</div>
            <button type="button" className={`settings-nav-item ${activeCategory === 'harnesses' ? 'active' : ''}`} onClick={() => setActiveCategory('harnesses')}>
              <Terminal size={15}/><span>Harnesses</span>
            </button>
            <button
              type="button"
              className={`settings-nav-item ${activeCategory === 'memories' ? 'active' : ''}`}
              onClick={() => setActiveCategory('memories')}
            >
              <Database size={15} />
              <span>User memories</span>
            </button>
            <button
              type="button"
              className={`settings-nav-item ${activeCategory === 'agent-access' ? 'active' : ''}`}
              onClick={() => setActiveCategory('agent-access')}
            >
              <Shield size={15} />
              <span>Agent access</span>
            </button>
            {pluginSettingsTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-nav-item ${activeCategory === tab.id ? 'active' : ''}`}
                onClick={() => setActiveCategory(tab.id)}
              >
                {tab.icon ?? <Puzzle size={15} />}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-main">
            {activeCategory === 'general' && (
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>General Settings</h3>
                  <p className="settings-section-description">Configure application behavior.</p>
                </div>

                <div className="settings-card">
                  <SettingRow
                    label="Smooth scrolling"
                    description="Animate mouse wheel scrolling instead of jumping line by line (trackpads always scroll natively)"
                    control={
                      <label className="settings-toggle">
                        <input
                          type="checkbox"
                          checked={smoothScroll}
                          onChange={(e) => setSmoothScroll(e.target.checked)}
                        />
                        <span className="settings-toggle-slider" />
                      </label>
                    }
                  />

                  <SettingRow
                    label="Version"
                    description={`${appVersion ? `Agent MCR ${appVersion}. ` : ''}The app does not update itself and does not look for new versions.`}
                    control={null}
                  />
                </div>
              </div>
            )}

            {activeCategory === 'plugins' && <PluginsSettingsSection />}
            {activeCategory === 'harnesses' && <HarnessSettingsSection />}

            {activeCategory === 'memories' && <MemoryConnection />}
            {activeCategory === 'memories' && (
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>User memories</h3>
                  <p className="settings-section-description">Inspect TEOB memories across recorded workspaces.</p>
                </div>
                <div className="session-cockpit settings-embedded-host">
                  <SessionMemoryBrowser />
                </div>
              </div>
            )}

            {activeCategory === 'agent-access' && (
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>Agent access</h3>
                </div>
                <div className="settings-embedded-host">
                  <SessionAgentAccess
                    embedded
                    directory=""
                    inspect={() => {
                      setSettingsOpen(false);
                    }}
                  />
                </div>
              </div>
            )}

            {pluginSettingsTabs.map((tab) =>
              activeCategory === tab.id ? (
                <React.Fragment key={tab.id}>{tab.render()}</React.Fragment>
              ) : null
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
