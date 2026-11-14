import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Copy, FolderOpen, Play, Square, Trash2, Zap } from 'lucide-react';
import TerminalPane from './TerminalPane';
import { harnessApi, hostedLabel, hostedState, maybeOpenElsewhere, STATE_LABEL, type HarnessStatus, type Hosted, type Resumable } from '../utils/harness';
import { pickDirectory, isTauri } from '../utils/tauri';
import { formatAge } from '../utils/agent';
import { useStore } from '../store';
import '../styles/harness.css';

const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const base = (path: string) => path.split('/').filter(Boolean).pop() || path;

/**
 * Agent terminals hosted by the runner. They keep running when this view, the
 * Sessions workspace or the whole app closes (docs/AGENT_HARNESS_DESIGN.md, D1).
 */
export default function LiveWorkspace({ active, recentDirectories }: { active: boolean; recentDirectories: string[] }) {
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [hosted, setHosted] = useState<Hosted[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [opened, setOpened] = useState<string[]>([]);
  const [profile, setProfile] = useState('claude');
  const [cwd, setCwd] = useState('');
  const [starting, setStarting] = useState(false);
  const [resumable, setResumable] = useState<Resumable[]>([]);
  const [resume, setResume] = useState('');
  const [copied, setCopied] = useState(false);
  const openedFolders = useStore(s => s.directories);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try { const list = await harnessApi.list(); if (mounted.current) { setHosted(list); setError(''); } }
    catch (e) { if (mounted.current) setError(err(e)); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!isTauri()) { setError('Open the desktop app to host agent terminals.'); return; }
    harnessApi.status().then(s => { if (mounted.current) { setStatus(s); setCwd(c => c || s.home); } }).catch(e => setError(err(e)));
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!active || !status) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [active, status, refresh]);

  // Earlier sessions to resume; without the Sessions grant there are none to offer
  const loadResumable = useCallback(() => { harnessApi.resumable().then(r => { if (mounted.current) setResumable(r); }).catch(() => {}); }, []);
  useEffect(() => { if (active && status) loadResumable(); }, [active, status, loadResumable]);

  const select = (id: string) => {
    setSelected(id); setOpened(o => o.includes(id) ? o : [...o, id]);
    if (hosted.find(h => h.id === id)?.harness?.attention?.kind === 'notification') void harnessApi.ack(id).then(refresh).catch(() => {});
  };
  const waiting = useMemo(() => hosted.filter(h => !h.exit && h.harness?.attention), [hosted]);
  const suggestions = useMemo(() => [...new Set([status?.home ?? '', ...openedFolders, ...recentDirectories].filter(Boolean))].slice(0, 40), [status, openedFolders, recentDirectories]);
  // Sessions that need the person come first, ended ones last
  const needsYou = (h: Hosted) => !h.exit && !!h.harness?.attention;
  const sorted = useMemo(() => [...hosted].sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || Number(!!a.exit) - Number(!!b.exit) || b.started - a.started), [hosted]);
  const running = hosted.filter(h => !h.exit).length;

  const start = async () => {
    setStarting(true); setError('');
    try {
      const h = resume ? await harnessApi.spawn('', '', 120, 32, resume) : await harnessApi.spawn(profile, cwd, 120, 32);
      setResume(''); await refresh(); select(h.id); loadResumable();
    }
    catch (e) { setError(err(e)); }
    finally { setStarting(false); }
  };
  const act = (fn: () => Promise<void>) => { fn().then(refresh).catch(e => setError(err(e))); };

  return <div className="hs-live">
    <aside className="hs-list" aria-label="Hosted sessions">
      <form className="hs-new" onSubmit={e => { e.preventDefault(); void start(); }}>
        <div className="hs-new-row">
          <select aria-label="Launch profile" value={profile} disabled={!!resume} onChange={e => setProfile(e.target.value)}>
            {(status?.profiles ?? []).map(p => <option key={p.id} value={p.id} title={p.command}>{p.label}</option>)}
          </select>
          <button type="submit" className="hs-start" disabled={!status || (!cwd && !resume) || starting}><Play size={13}/> {starting ? 'Starting…' : resume ? 'Resume' : 'Start'}</button>
        </div>
        <div className="hs-new-row">
          <input aria-label="Working folder" list="hs-folders" value={cwd} disabled={!!resume} onChange={e => setCwd(e.target.value)} placeholder="Working folder"/>
          <button type="button" title="Choose a folder" aria-label="Choose a folder" onClick={async () => { try { const dir = await pickDirectory(); if (dir) setCwd(dir); } catch (e) { setError(err(e)); } }}><FolderOpen size={14}/></button>
          <datalist id="hs-folders">{suggestions.map(d => <option key={d} value={d}/>)}</datalist>
        </div>
        {resumable.length > 0 && <select aria-label="Resume an earlier session" value={resume} onChange={e => setResume(e.target.value)} title="Continue a Claude or Codex session here. Close it in its other terminal first.">
          <option value="">New session</option>
          {resumable.map(r => <option key={r.id} value={r.id}>{`${r.agent === 'claude' ? 'Claude' : 'Codex'} · ${base(r.cwd)} · ${formatAge(r.modified)}${maybeOpenElsewhere(r, Date.now()) ? ' · open elsewhere?' : ''}`}</option>)}
        </select>}
      </form>
      {waiting.length > 0 && <p className="hs-attention" role="status"><BellRing size={12}/> {waiting.length === 1 ? '1 session is waiting for you' : `${waiting.length} sessions are waiting for you`}</p>}
      {error && <div className="hs-error" role="alert">{error}</div>}
      <ul>
        {sorted.map(h => {
          const state = hostedState(h);
          return <li key={h.id} className={`${h.id === selected ? 'selected' : ''}${needsYou(h) ? ' needs-you' : ''}`}>
            <button className="hs-item" onClick={() => select(h.id)} title={`${h.argv.join(' ')}\n${h.cwd}`}>
              <span className={`hs-dot ${state}`} aria-label={STATE_LABEL[state]}/>
              <span className="hs-item-text">
                <strong>{hostedLabel(h)} · {base(h.cwd)}</strong>
                <small>{h.exit ? `exited ${h.exit.signal ? `by ${h.exit.signal}` : `with ${h.exit.code}`} · ${formatAge(h.exit.at)}` : `${STATE_LABEL[state]}${h.openTasks ? ` · ${h.openTasks} task${h.openTasks > 1 ? 's' : ''}` : ''} · pid ${h.pid ?? '?'}${h.lastOutput ? ` · output ${formatAge(h.lastOutput)}` : ''}`}</small>
                {needsYou(h) && <small className="hs-needs">{h.harness?.attention?.text}</small>}
                {h.title && <small className="hs-title">{h.title}</small>}
              </span>
            </button>
            <span className="hs-actions">
              {!h.exit && <button title="Interrupt (Ctrl-C to the foreground process)" aria-label="Interrupt" onClick={() => act(() => harnessApi.signal(h.id, 'INT'))}><Zap size={13}/></button>}
              {!h.exit && <button title="Stop the session (hangup, as when a terminal window closes)" aria-label="Stop" onClick={() => act(() => harnessApi.signal(h.id, 'HUP'))}><Square size={13}/></button>}
              {h.exit && <button title="Forget this session and its output" aria-label="Forget" onClick={() => act(async () => { await harnessApi.forget(h.id); setOpened(o => o.filter(x => x !== h.id)); if (selected === h.id) setSelected(''); })}><Trash2 size={13}/></button>}
            </span>
          </li>;
        })}
      </ul>
      {!hosted.length && status && <p className="hs-empty">No hosted sessions. Start one above; it keeps running when you close the app.</p>}
      <footer className="hs-footer">
        <span>{status ? `Runner pid ${status.runner.pid} · ${running} running` : 'Connecting to the runner…'}</span>
        {status?.supervisorCommand && <button title={`Copy the command that gives an outside Claude Code the supervisor tools:\n${status.supervisorCommand}`} aria-label="Copy supervisor setup command" onClick={() => { void navigator.clipboard.writeText(status.supervisorCommand ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(e => setError(err(e))); }}><Copy size={12}/> {copied ? 'Copied' : 'Supervisor'}</button>}
      </footer>
    </aside>
    <main className="hs-terminals">
      {opened.filter(id => hosted.some(h => h.id === id)).map(id => <div key={id} className="hs-pane" hidden={id !== selected}><TerminalPane id={id} active={active && id === selected}/></div>)}
      {!selected && <div className="hs-placeholder"><p>Select a session, or start one.</p></div>}
    </main>
  </div>;
}
