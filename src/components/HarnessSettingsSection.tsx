import { useEffect, useState } from 'react';
import { SettingRow } from '@/ui';
import { HARNESS_PREFERENCES_CHANGED, harnessApi, type HarnessStatus, type HarnessPreferences } from '../utils/harness';
import { BackgroundPanel } from './Background';
import { useStore } from '../store';

/** What the switch does and where the person stands with Codex's own trust step. */
export function codexHooksDescription(status: HarnessStatus): string {
  const what = 'Start new Codex sessions with hooks that report their state to Agent MCR: the conversation from its start, and what Codex asks to approve. They never answer for you.';
  if (!status.codexHooks) return `${what} Off: Agent MCR reads a Codex prompt from its terminal instead, as a guess.`;
  if (status.codexHooksReporting) return `${what} On, and Codex runs them: a session has reported through them.`;
  return `${what} On. Codex asks once to review them: start a Codex session and choose "Trust all and continue". Until then new Codex sessions stop at that question.`;
}

/** The query answer (MCR-115): what it writes, where, and why it is off unless needed. */
export function programQueryDescription(on: boolean): string {
  const what = 'Programs can report their state in their output (OSC 7501); the Live list shows it as their word, below what the hooks say. A program may first ask whether the terminal reads such reports.';
  return on
    ? `${what} On: Agent MCR answers with a fixed line written to the session's input, never into a line you have not sent. Any output can ask, a file shown in the terminal too.`
    : `${what} Off: nothing is answered; reports are shown all the same.`;
}

const endedWithoutReports = async () => (await harnessApi.list())
  .filter(h => h.exit && !h.harness?.attention?.report).map(h => h.id);

export default function HarnessSettingsSection() {
  const [prefs, setPrefs] = useState<HarnessPreferences | null>(null);
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ended, setEnded] = useState<string[]>([]);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState('');
  const hideNoise = useStore(s => s.liveList.hideNoise);
  const setLiveList = useStore(s => s.setLiveList);
  useEffect(() => {
    let active = true;
    harnessApi.status().then(async s => {
      if (!active) return;
      setStatus(s);
      const ids = await endedWithoutReports();
      if (active) setEnded(ids);
    }).catch(e => { if (active) setError(String(e)); });
    harnessApi.preferences().then(p => { if (active) setPrefs(p); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);

  const save = async (enabledProfiles: string[], supervisorProfile: string | null) => {
    setSaving(true); setError('');
    try { setPrefs(await harnessApi.savePreferences({ enabledProfiles, supervisorProfile })); }
    catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };
  const forgetEnded = async () => {
    setForgetting(true); setError('');
    try {
      for (const id of ended) {
        try { await harnessApi.forget(id); setEnded(ids => ids.filter(x => x !== id)); }
        catch (e) { setError(String(e)); }
      }
      setEnded(await endedWithoutReports());
    } catch (e) { setError(String(e)); }
    finally { setForgetting(false); }
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
      {status && <SettingRow label="Use Codex hooks" description={codexHooksDescription(status)} control={
        <label className="settings-toggle">
          <input type="checkbox" aria-label="Use Codex hooks" checked={!!status.codexHooks} onChange={e => { void harnessApi.codexHooks(e.target.checked).then(on => setStatus({ ...status, codexHooks: on })).catch(e => setError(String(e))); }}/>
          <span className="settings-toggle-slider"/>
        </label>
      }/>}
      {status && <SettingRow label="Answer program status queries" description={programQueryDescription(!!status.programQuery)} control={
        <label className="settings-toggle">
          <input type="checkbox" aria-label="Answer program status queries" checked={!!status.programQuery} onChange={e => { void harnessApi.programQuery(e.target.checked).then(on => setStatus({ ...status, programQuery: on })).catch(e => setError(String(e))); }}/>
          <span className="settings-toggle-slider"/>
        </label>
      }/>}
      {status?.supervisorCommand && <SettingRow label="Supervisor setup command" description={status.supervisorCommand} control={<button type="button" onClick={() => { void navigator.clipboard.writeText(status.supervisorCommand!).then(() => setCopied(true)).catch(e => setError(String(e))); }}>{copied ? 'Copied' : 'Copy'}</button>}/>}
      <SettingRow label="Supervisor" description="Harness for the next supervisor session. Close the current supervisor to switch." control={
        <select aria-label="Supervisor harness" value={prefs.supervisorProfile ?? ''} disabled={saving} onChange={e => void save(prefs.enabledProfiles, e.target.value || null)}>
          <option value="">None</option>
          {prefs.profiles.filter(p => p.canSupervise && prefs.enabledProfiles.includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      }/>
      <SettingRow label="Leave out temporary and removed folders" description="In the Live list, folders that are no longer on disk (a removed worktree) and agents' temporary folders (scratchpads in the system's temp folder, .claude/live-check test homes) go to Hidden folders by themselves. A folder with a running session always shows. Nothing is deleted." control={
        <label className="settings-toggle">
          <input type="checkbox" aria-label="Leave out temporary and removed folders" checked={hideNoise} onChange={e => { const on = e.target.checked; setLiveList(p => ({ ...p, hideNoise: on })); }}/>
          <span className="settings-toggle-slider"/>
        </label>
      }/>
      {status && ended.length > 0 && <SettingRow label="Ended sessions" description="Release terminal output from ended sessions. Saved conversations stay in Earlier and Journal. Mark open reports as seen before forgetting their sessions." control={
        <button type="button" disabled={forgetting} onClick={() => void forgetEnded()}>Forget ended sessions · {ended.length}</button>
      }/>}
      <SettingRow label="Background processes" description="Runner and harness service keep sessions alive when the app closes." control={
        <button type="button" aria-expanded={backgroundOpen} onClick={() => setBackgroundOpen(open => !open)}>{backgroundOpen ? 'Hide' : 'Manage…'}</button>
      }/>
      {backgroundOpen && <BackgroundPanel onStopped={() => { setBackgroundOpen(false); setStatus(null); window.dispatchEvent(new Event(HARNESS_PREFERENCES_CHANGED)); }}/>}
    </div>}
    {prefs?.profiles.some(p => p.canSupervise && !p.taskTracking) && <p className="settings-section-description">Automatic task tracking is unavailable for {prefs.profiles.filter(p => p.canSupervise && !p.taskTracking).map(p => p.label).join(', ')}.</p>}
  </div>;
}
