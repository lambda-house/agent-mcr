import React, { useCallback, useEffect, useState } from 'react';
import { X, Trash2, Settings, Code, Plus, Palette } from 'lucide-react';
import { useStore } from '../store';
import { isTauri, checkForUpdate, getAppVersion } from '../utils/tauri';

type SettingsCategory = 'general' | 'appearance' | 'highlighting';

const SettingsModal: React.FC = () => {
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const smoothScroll = useStore((s) => s.smoothScroll);
  const setSmoothScroll = useStore((s) => s.setSmoothScroll);
  const checkUpdatesOnStart = useStore((s) => s.checkUpdatesOnStart);
  const setCheckUpdatesOnStart = useStore((s) => s.setCheckUpdatesOnStart);
  const setAvailableUpdate = useStore((s) => s.setAvailableUpdate);
  const [updateStatus, setUpdateStatus] = useState('');
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    getAppVersion().then(setAppVersion).catch(() => {});
  }, []);
  const loadRemoteImages = useStore((s) => s.loadRemoteImages);
  const setLoadRemoteImages = useStore((s) => s.setLoadRemoteImages);
  const languageAliases = useStore((s) => s.languageAliases);
  const setLanguageAlias = useStore((s) => s.setLanguageAlias);
  const removeLanguageAlias = useStore((s) => s.removeLanguageAlias);
  const markdownTextColor = useStore((s) => s.markdownTextColor);
  const markdownTextColorLight = useStore((s) => s.markdownTextColorLight);
  const setMarkdownTextColorLight = useStore((s) => s.setMarkdownTextColorLight);
  const setMarkdownTextColor = useStore((s) => s.setMarkdownTextColor);

  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('general');
  const [newAliasKey, setNewAliasKey] = useState('');
  const [newAliasValue, setNewAliasValue] = useState('');

  const handleClose = useCallback(() => {
    setSettingsOpen(false);
  }, [setSettingsOpen]);

  const handleAddAlias = useCallback(() => {
    if (newAliasKey.trim() && newAliasValue.trim()) {
      setLanguageAlias(newAliasKey.trim(), newAliasValue.trim());
      setNewAliasKey('');
      setNewAliasValue('');
    }
  }, [newAliasKey, newAliasValue, setLanguageAlias]);

  // Handle Escape key to close modal
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
    <div className="modal-overlay" onClick={handleClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button
            className="settings-close"
            onClick={handleClose}
            title="Close (Escape)"
          >
            <X size={20} />
          </button>
        </div>

        <div className="settings-content">
          <div className="settings-sidebar">
            <button
              className={`settings-nav-item ${activeCategory === 'general' ? 'active' : ''}`}
              onClick={() => setActiveCategory('general')}
            >
              <Settings size={16} />
              <span>General</span>
            </button>
            <button
              className={`settings-nav-item ${activeCategory === 'appearance' ? 'active' : ''}`}
              onClick={() => setActiveCategory('appearance')}
            >
              <Palette size={16} />
              <span>Appearance</span>
            </button>
            <button
              className={`settings-nav-item ${activeCategory === 'highlighting' ? 'active' : ''}`}
              onClick={() => setActiveCategory('highlighting')}
            >
              <Code size={16} />
              <span>Highlighting</span>
            </button>
          </div>

          <div className="settings-main">
            {activeCategory === 'general' && (
              <div className="settings-section">
                <h3>General Settings</h3>
                <p className="settings-section-description">
                  Configure application behavior.
                </p>

                <div className="settings-option">
                  <div className="settings-option-info">
                    <span className="settings-option-label">Smooth scrolling</span>
                    <span className="settings-option-description">
                      Animate mouse wheel scrolling instead of jumping line by line (trackpads always scroll natively)
                    </span>
                  </div>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={smoothScroll}
                      onChange={(e) => setSmoothScroll(e.target.checked)}
                    />
                    <span className="settings-toggle-slider" />
                  </label>
                </div>

                <div className="settings-option">
                  <div className="settings-option-info">
                    <span className="settings-option-label">Load remote images</span>
                    <span className="settings-option-description">
                      Show images from the web without asking. Loading them tells their server when you read a document
                    </span>
                  </div>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={loadRemoteImages}
                      onChange={(e) => setLoadRemoteImages(e.target.checked)}
                    />
                    <span className="settings-toggle-slider" />
                  </label>
                </div>

                <div className="settings-option">
                  <div className="settings-option-info">
                    <span className="settings-option-label">Check for updates on start</span>
                    <span className="settings-option-description">
                      {appVersion && `You have Agent MCR ${appVersion}. `}
                      {updateStatus || 'Look for a new version on GitHub when the app starts. Updates install only when you click Install'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="settings-button"
                    disabled={!isTauri() || updateStatus === 'Checking…'}
                    onClick={async () => {
                      setUpdateStatus('Checking…');
                      try {
                        const update = await checkForUpdate();
                        setAvailableUpdate(update);
                        setUpdateStatus(update ? `Version ${update.version} is available, see the bar above` : 'You have the latest version');
                      } catch (error) {
                        const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
                        setUpdateStatus(`Could not check: ${message}`);
                      }
                    }}
                  >
                    Check now
                  </button>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={checkUpdatesOnStart}
                      onChange={(e) => setCheckUpdatesOnStart(e.target.checked)}
                    />
                    <span className="settings-toggle-slider" />
                  </label>
                </div>
              </div>
            )}

            {activeCategory === 'appearance' && (
              <div className="settings-section">
                <h3>Appearance</h3>
                <p className="settings-section-description">
                  Customize the look of rendered markdown content.
                </p>

                <div className="settings-option">
                  <div className="settings-option-info">
                    <span className="settings-option-label">Markdown text color (dark theme)</span>
                    <span className="settings-option-description">
                      Primary text color for rendered markdown in the dark theme
                    </span>
                  </div>
                  <input
                    type="color"
                    value={markdownTextColor}
                    onChange={(e) => setMarkdownTextColor(e.target.value)}
                    className="settings-color-input"
                  />
                </div>

                <div className="settings-option">
                  <div className="settings-option-info">
                    <span className="settings-option-label">Markdown text color (light theme)</span>
                    <span className="settings-option-description">
                      Primary text color for rendered markdown in the light theme
                    </span>
                  </div>
                  <input
                    type="color"
                    value={markdownTextColorLight}
                    onChange={(e) => setMarkdownTextColorLight(e.target.value)}
                    className="settings-color-input"
                  />
                </div>
              </div>
            )}

            {activeCategory === 'highlighting' && (
              <div className="settings-section">
                <h3>Language Aliases</h3>
                <p className="settings-section-description">
                  Map code block language identifiers to syntax highlighters.
                  For example, "sc" can be mapped to "scala".
                </p>

                <div className="settings-alias-list">
                  {Object.entries(languageAliases).length === 0 ? (
                    <div className="settings-alias-empty">
                      No aliases configured.
                    </div>
                  ) : (
                    Object.entries(languageAliases)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([alias, lang]) => (
                        <div key={alias} className="settings-alias-item">
                          <code className="settings-alias-key">{alias}</code>
                          <span className="settings-alias-arrow">&rarr;</span>
                          <code className="settings-alias-value">{lang}</code>
                          <button
                            className="settings-alias-remove"
                            onClick={() => removeLanguageAlias(alias)}
                            title="Remove alias"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))
                  )}
                </div>

                <div className="settings-alias-add">
                  <input
                    type="text"
                    className="settings-alias-input"
                    placeholder="Alias (e.g., sc)"
                    value={newAliasKey}
                    onChange={(e) => setNewAliasKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddAlias()}
                  />
                  <span className="settings-alias-arrow">&rarr;</span>
                  <input
                    type="text"
                    className="settings-alias-input"
                    placeholder="Language (e.g., scala)"
                    value={newAliasValue}
                    onChange={(e) => setNewAliasValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddAlias()}
                  />
                  <button
                    className="settings-alias-add-btn"
                    onClick={handleAddAlias}
                    disabled={!newAliasKey.trim() || !newAliasValue.trim()}
                    title="Add alias"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
