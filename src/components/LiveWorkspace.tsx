import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, BellRing, Copy, FolderOpen, MoreHorizontal, Play, Radar, RotateCw, X } from 'lucide-react';
import TerminalPane from './TerminalPane';
import AgentMark from './AgentMark';
import SessionStats from './SessionStats';
import { canRestart, groupSessions, harnessApi, hostedLabel, hostedState, isSupervisor, maybeOpenElsewhere, sessionReference, STATE_LABEL, subagentActive, type HarnessStatus, type Hosted, type Resumable } from '../utils/harness';
import { pickDirectory, isTauri } from '../utils/tauri';
import { formatAge } from '../utils/agent';
import { useStore } from '../store';
import '../styles/harness.css';

const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const base = (path: string) => path.split('/').filter(Boolean).pop() || path;

interface Action { label: string; icon: React.ReactNode; run: () => void }

/** The one button of a session row: its actions open as a menu. */
function RowMenu({ label, actions }: { label: string; actions: Action[] }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!at) return;
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setAt(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); };
  }, [at]);
  return <span className="hs-actions" ref={wrap}>
    <button type="button" aria-haspopup="menu" aria-expanded={!!at} aria-label={`Actions for ${label}`} title="Actions" onClick={e => {
      // Fixed position: the list scrolls and would clip a menu placed inside it
      const box = e.currentTarget.getBoundingClientRect();
      setAt(at ? null : { top: box.bottom + 2, right: Math.max(4, window.innerWidth - box.right) });
    }}><MoreHorizontal size={14}/></button>
    {at && <div className="hs-menu" role="menu" style={{ top: at.top, right: at.right }}>
      {actions.map(a => <button key={a.label} type="button" role="menuitem" onClick={() => { setAt(null); a.run(); }}>{a.icon} {a.label}</button>)}
    </div>}
  </span>;
}

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
  const [referenced, setReferenced] = useState('');
  // The usage pane beside the terminal: open or closed is this viewer's preference
  const [stats, setStats] = useState(() => { try { return localStorage.getItem('hs-stats') === '1'; } catch { return false; } });
  const toggleStats = () => setStats(on => { try { localStorage.setItem('hs-stats', on ? '0' : '1'); } catch { /* not kept */ } return !on; });
  // Sessions the person closed: once they have ended they leave the list too
  const closing = useRef(new Set<string>());
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
  // Sessions that need the person come first, ended ones last. The supervisor has its own tile above the list
  const needsYou = (h: Hosted) => !h.exit && !!h.harness?.attention;
  const sorted = useMemo(() => hosted.filter(h => h.exit || !isSupervisor(h)).sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || Number(!!a.exit) - Number(!!b.exit) || b.started - a.started), [hosted]);
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
  const supervisor = hosted.find(h => !h.exit && isSupervisor(h));
  const openSupervisor = async () => {
    if (supervisor) { select(supervisor.id); return; }
    setStarting(true); setError('');
    try { const h = await harnessApi.supervisor(120, 32); await refresh(); select(h.id); }
    catch (e) { setError(err(e)); }
    finally { setStarting(false); }
  };
  const act = (fn: () => Promise<void>) => { fn().then(refresh).catch(e => setError(err(e))); };
  const forget = (id: string) => act(async () => { await harnessApi.forget(id); closing.current.delete(id); setOpened(o => o.filter(x => x !== id)); setSelected(s => s === id ? '' : s); });
  /** One step to be rid of a session: it is ended, then dropped from the list with its output. */
  const close = (h: Hosted) => {
    if (h.exit) { forget(h.id); return; }
    closing.current.add(h.id);
    act(() => harnessApi.signal(h.id, 'HUP'));
  };
  useEffect(() => { hosted.filter(h => h.exit && closing.current.has(h.id)).forEach(h => forget(h.id)); }, [hosted]); // eslint-disable-line react-hooks/exhaustive-deps
  const copyReference = (h: Hosted) => {
    navigator.clipboard.writeText(sessionReference(h)).then(() => { setReferenced(h.id); setTimeout(() => setReferenced(r => r === h.id ? '' : r), 1500); }).catch(e => setError(err(e)));
  };
  /** The agent is ended and continues its conversation in a new process, with today's settings and tools. */
  const restart = (h: Hosted) => {
    setError('');
    harnessApi.restart(h.id).then(async fresh => {
      await refresh();
      setOpened(o => o.filter(x => x !== h.id));
      if (selected === h.id) select(fresh.id);
      if (!fresh.resumed) setError(`${hostedLabel(h)} had no saved conversation to continue: it started fresh in the same folder.`);
    }).catch(e => { setError(err(e)); void refresh(); });
  };
  const actions = (h: Hosted): Action[] => [
    { label: 'Copy reference', icon: <Copy size={13}/>, run: () => copyReference(h) },
    ...(canRestart(h) ? [{ label: 'Restart (reload settings)', icon: <RotateCw size={13}/>, run: () => restart(h) }] : []),
    { label: h.exit ? 'Remove from the list' : 'Close session', icon: <X size={13}/>, run: () => close(h) },
  ];
  const groups = useMemo(() => groupSessions(sorted), [sorted]);
  const row = (h: Hosted) => {
    const state = hostedState(h);
    const label = hostedLabel(h);
    const detail = h.exit
      ? `exited ${h.exit.signal ? `by ${h.exit.signal}` : `with ${h.exit.code}`} · ${formatAge(h.exit.at)}`
      : [h.openTasks ? `${h.openTasks} task${h.openTasks > 1 ? 's' : ''}` : '', h.unread ? `${h.unread} unread` : '', referenced === h.id ? 'reference copied' : ''].filter(Boolean).join(' · ');
    const subs = (h.subagents ?? []).filter(a => !a.finished);
    return <li key={h.id} className={[h.id === selected ? 'selected' : '', needsYou(h) ? 'needs-you' : '', !needsYou(h) && (state === 'idle' || h.exit) ? 'idle' : ''].filter(Boolean).join(' ')}>
      <button className="hs-item" onClick={() => select(h.id)} title={`${STATE_LABEL[state]} · pid ${h.pid ?? '?'}\n${h.argv.join(' ')}\n${h.cwd}`}>
        <span className={`hs-dot ${state}`} aria-label={STATE_LABEL[state]}/>
        <span className="hs-item-text">
          <strong><AgentMark profile={h.harness?.profile || h.meta.profile || ''}/> {label} · {base(h.cwd)}</strong>
          {detail && <small>{detail}</small>}
          {needsYou(h) && <small className="hs-needs">{h.harness?.attention?.text}</small>}
          {!h.exit && h.harness?.status && <small className="hs-status">{h.harness.status}</small>}
        </span>
      </button>
      <RowMenu label={label} actions={actions(h)}/>
      {subs.length > 0 && <ul className="hs-subs" aria-label={`Subagents of ${label}`}>
        {subs.map(a => {
          const live = subagentActive(a, Date.now());
          return <li key={a.id} className={live ? 'active' : ''} title={[a.agentType, a.model, live ? 'active' : `quiet, last activity ${formatAge(a.lastActivity)}`, `started ${formatAge(a.started)}`].filter(Boolean).join(' · ')}>
            <span className={`hs-dot ${live ? 'working' : ''}`} aria-label={live ? 'active' : 'quiet'}/>
            <span className="hs-item-text"><strong>{a.description || `Subagent ${a.id.slice(0, 8)}`}</strong></span>
          </li>;
        })}
      </ul>}
    </li>;
  };

  return <div className="hs-live">
    <aside className="hs-list" aria-label="Hosted sessions">
      <div className={`hs-supervisor${supervisor ? ' running' : ''}${supervisor && supervisor.id === selected ? ' selected' : ''}${supervisor && needsYou(supervisor) ? ' needs-you' : ''}`}>
        <button type="button" className="hs-supervisor-open" disabled={!status || starting} onClick={() => void openSupervisor()}
          title="A Claude session wired to this harness: it sees and directs all the other sessions. It cannot answer their permission prompts; only you can.">
          <Radar size={18}/>
          <span className="hs-item-text">
            <strong>{supervisor ? 'Supervisor' : 'Open supervisor'}{supervisor && <span className={`hs-dot ${hostedState(supervisor)}`} aria-label={STATE_LABEL[hostedState(supervisor)]}/>}</strong>
            {!supervisor && <small>Sees and directs all sessions</small>}
            {supervisor && referenced === supervisor.id && <small>reference copied</small>}
            {supervisor && needsYou(supervisor) && <small className="hs-needs">{supervisor.harness?.attention?.text}</small>}
            {supervisor?.harness?.status && <small className="hs-status">{supervisor.harness.status}</small>}
          </span>
        </button>
        {supervisor && <RowMenu label="the supervisor" actions={actions(supervisor)}/>}
      </div>
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
        {groups.map(group => group.length === 1 ? row(group[0])
          : <li key={`group-${group[0].id}`} className="hs-group" title="These sessions run in the same folder or exchanged messages in the last day">
            <ul aria-label="Sessions working together">{group.map(row)}</ul>
          </li>)}
      </ul>
      {!hosted.length && status && <p className="hs-empty">No hosted sessions. Start one above; it keeps running when you close the app.</p>}
      <footer className="hs-footer">
        <span>{status ? `Runner pid ${status.runner.pid} · ${running} running` : 'Connecting to the runner…'}</span>
        {status?.supervisorCommand && <button title={`Copy the command that gives an outside Claude Code the supervisor tools:\n${status.supervisorCommand}`} aria-label="Copy supervisor setup command" onClick={() => { void navigator.clipboard.writeText(status.supervisorCommand ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(e => setError(err(e))); }}><Copy size={12}/> {copied ? 'Copied' : 'Supervisor'}</button>}
      </footer>
    </aside>
    <main className="hs-terminals">
      {opened.map(id => hosted.find(h => h.id === id)).filter((h): h is Hosted => !!h).map(h => <div key={h.id} className="hs-pane" hidden={h.id !== selected}>
        <header className="hs-pane-title">
          <span className={`hs-dot ${hostedState(h)}`} aria-label={STATE_LABEL[hostedState(h)]}/>
          <AgentMark profile={h.harness?.profile || h.meta.profile || ''}/>
          <strong>{isSupervisor(h) ? 'Supervisor' : hostedLabel(h)}</strong>
          <span title={h.cwd}>{h.cwd}</span>
          <button type="button" className="hs-stats-toggle" aria-pressed={stats} title="Tokens, context size, tools and skills of this session" onClick={toggleStats}><BarChart3 size={13}/> Usage</button>
        </header>
        <div className="hs-pane-body">
          <TerminalPane id={h.id} active={active && h.id === selected}/>
          {stats && h.id === selected && <SessionStats session={h} active={active}/>}
        </div>
      </div>)}
      {!selected && <div className="hs-placeholder"><p>Select a session, or start one.</p></div>}
    </main>
  </div>;
}
