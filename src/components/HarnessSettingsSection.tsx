import { useEffect, useState } from 'react';
import { SettingRow } from '@teob/ui';
import { HARNESS_PREFERENCES_CHANGED, harnessApi, type HarnessStatus, type HarnessPreferences } from '../utils/harness';
import { BackgroundPanel } from './Background';

export default function HarnessSettingsSection() {
  const [prefs, setPrefs] = useState<HarnessPreferences | null>(null);
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    harnessApi.status().then(s => { if (active) setStatus(s); }).catch(e => { if (active) setError(String(e)); });
    harnessApi.preferences().then(p => { if (active) setPrefs(p); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);

  const save = async (enabledProfiles: string[], supervisorProfile: string | null) => {
    setSaving(true); setError('');
    try { setPrefs(await harnessApi.savePreferences({ enabledProfiles, supervisorProfile })); }
    catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  return <div className="settings-section">
    <div className="settings-section-head">
      <h3>Harnesses</h3>
      <p className="settings-section-description">Choose built-in harnesses and optional adapter plugins. Install and sign in to each CLI first. Changes apply to every new-session menu. Running sessions and saved history stay available.</p>
    </div>
    {error && <p role="alert">{error}</p>}
    {!prefs && !error && <p role="status">Loading harnesses…</p>}
    {prefs && <div className="settings-card">
      {prefs.profiles.map(p => <SettingRow key={p.id} label={p.label} description={`${p.optional ? 'Optional plugin' : 'Built in'} · ${p.command || 'Your login shell'}`} control={
        <label className="settings-toggle">
          <input type="checkbox" aria-label={`Enable ${p.label}`} checked={prefs.enabledProfiles.includes(p.id)} disabled={saving} onChange={e => {
            const enabled = e.target.checked ? [...prefs.enabledProfiles, p.id] : prefs.enabledProfiles.filter(id => id !== p.id);
            const supervisor = prefs.supervisorProfile && enabled.includes(prefs.supervisorProfile) ? prefs.supervisorProfile : null;
            void save(enabled, supervisor);
          }}/>
          <span className="settings-toggle-slider"/>
        </label>
      }/>)}
      {status && <SettingRow label="Outside agents" description="Allow connected agents outside Agent MCR to use supervisor tools." control={<input type="checkbox" aria-label="Allow outside agents" checked={!!status.outsideSupervisors} onChange={e => { void harnessApi.outsideSupervisors(e.target.checked).then(on => setStatus({ ...status, outsideSupervisors: on })).catch(e => setError(String(e))); }}/>}/>}
      {status?.supervisorCommand && <SettingRow label="Supervisor setup command" description={status.supervisorCommand} control={<button type="button" onClick={() => { void navigator.clipboard.writeText(status.supervisorCommand!).then(() => setCopied(true)).catch(e => setError(String(e))); }}>{copied ? 'Copied' : 'Copy'}</button>}/>}
      <SettingRow label="Supervisor" description="Harness for the next supervisor session. Close the current supervisor to switch." control={
        <select aria-label="Supervisor harness" value={prefs.supervisorProfile ?? ''} disabled={saving} onChange={e => void save(prefs.enabledProfiles, e.target.value || null)}>
          <option value="">None</option>
          {prefs.profiles.filter(p => p.canSupervise && prefs.enabledProfiles.includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      }/>
      <SettingRow label="Background processes" description="Runner and harness service keep sessions alive when the app closes." control={
        <button type="button" aria-expanded={backgroundOpen} onClick={() => setBackgroundOpen(open => !open)}>{backgroundOpen ? 'Hide' : 'Manage…'}</button>
      }/>
      {backgroundOpen && <BackgroundPanel onStopped={() => { setBackgroundOpen(false); setStatus(null); window.dispatchEvent(new Event(HARNESS_PREFERENCES_CHANGED)); }}/>}
    </div>}
    {prefs?.profiles.some(p => p.canSupervise && !p.taskTracking) && <p className="settings-section-description">Automatic task tracking is unavailable for {prefs.profiles.filter(p => p.canSupervise && !p.taskTracking).map(p => p.label).join(', ')}.</p>}
  </div>;
}
