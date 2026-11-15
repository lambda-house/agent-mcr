import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, BellRing, ChevronDown, ChevronRight, Copy, Terminal, FolderOpen, FolderPlus, History, MoreHorizontal, Plus, Radar, RotateCw, Search, X } from 'lucide-react';
import TerminalPane from './TerminalPane';
import AgentMark from './AgentMark';
import SessionStats from './SessionStats';
import { canRestart, directorySections, shortPath, tildePath, harnessApi, hostedLabel, hostedState, isSupervisor, maybeOpenElsewhere, runningFor, sessionReference, shellHealth, STATE_LABEL, subagentActive, type HarnessStatus, type Hosted, type Resumable } from '../utils/harness';
import { pickDirectory, isTauri } from '../utils/tauri';
import { formatAge } from '../utils/agent';
import { useStore } from '../store';
import '../styles/harness.css';

const err = (e: unknown) => e instanceof Error ? e.message : String(e);

interface Action { label: string; icon: React.ReactNode; run: () => void }

/** A button whose actions open as a menu: the "…" of a session row, the "+" of a folder. */
function RowMenu({ label, actions, icon, title = 'Actions', className = 'hs-actions', disabled = false }: { label: string; actions: Action[]; icon?: React.ReactNode; title?: string; className?: string; disabled?: boolean }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!at) return;
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setAt(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); };
  }, [at]);
  return <span className={className} ref={wrap}>
    <button type="button" aria-haspopup="menu" aria-expanded={!!at} aria-label={label} title={title} disabled={disabled} onClick={e => {
      // Fixed position: the list scrolls and would clip a menu placed inside it
      const box = e.currentTarget.getBoundingClientRect();
      setAt(at ? null : { top: box.bottom + 2, right: Math.max(4, window.innerWidth - box.right) });
    }}>{icon ?? <MoreHorizontal size={14}/>}</button>
    {at && <div className="hs-menu" role="menu" style={{ top: at.top, right: at.right }}>
      {actions.map(a => <button key={a.label} type="button" role="menuitem" onClick={() => { setAt(null); a.run(); }}>{a.icon} {a.label}</button>)}
    </div>}
  </span>;
}

/**
 * Agent terminals hosted by the runner. They keep running when this view, the
 * Sessions workspace or the whole app closes (docs/AGENT_HARNESS_DESIGN.md, D1).
 */
const PINNED_KEY = 'hs-dirs';
const START: [string, string][] = [['claude', 'Claude Code'], ['codex', 'Codex']];
/** Folders with only history shown before "more" is asked for. */
const HISTORY_FOLDERS = 6;

export default function LiveWorkspace({ active, recentDirectories, titles = {}, onSearch }: {
  active: boolean; recentDirectories: string[];
  /** Titles of earlier sessions by conversation id, when the Sessions index has them */
  titles?: Record<string, string>;
  /** Open the search view narrowed to a folder */
  onSearch?: (directory: string) => void;
}) {
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [hosted, setHosted] = useState<Hosted[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [opened, setOpened] = useState<string[]>([]);
  const [cwd, setCwd] = useState('');
  const [starting, setStarting] = useState(false);
  const [resumable, setResumable] = useState<Resumable[]>([]);
  // Folders the person added: they stay as sections with nothing running in them
  const [pinned, setPinned] = useState<string[]>(() => { try { const v = JSON.parse(localStorage.getItem(PINNED_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; } });
  const pin = (next: string[]) => { setPinned(next); try { localStorage.setItem(PINNED_KEY, JSON.stringify(next)); } catch { /* not kept */ } };
  const [earlierOpen, setEarlierOpen] = useState<Set<string>>(new Set());
  const [allHistory, setAllHistory] = useState(false);
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
    harnessApi.status().then(s => { if (mounted.current) setStatus(s); }).catch(e => setError(err(e)));
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
  // Rows keep their place: running ones in the order they were started, ended ones after them.
  // One that needs the person is marked, not moved. The supervisor has its own tile above the list
  const needsYou = (h: Hosted) => !h.exit && !!h.harness?.attention;
  const sorted = useMemo(() => hosted.filter(h => h.exit || !isSupervisor(h)).sort((a, b) => Number(!!a.exit) - Number(!!b.exit) || a.started - b.started || a.id.localeCompare(b.id)), [hosted]);
  const running = hosted.filter(h => !h.exit).length;

  const launch = async (spawn: () => Promise<Hosted>) => {
    setStarting(true); setError('');
    try { const h = await spawn(); await refresh(); select(h.id); loadResumable(); }
    catch (e) { setError(err(e)); }
    finally { setStarting(false); }
  };
  const start = (profile: string, dir: string) => launch(() => harnessApi.spawn(profile, dir, 120, 32));
  const resume = (id: string) => launch(() => harnessApi.spawn('', '', 120, 32, id));
  const addFolder = (dir: string) => { const path = dir.trim().replace(/(.)\/+$/, '$1'); if (path && !pinned.includes(path)) pin([...pinned, path]); setCwd(''); };
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
  const home = status?.home ?? '';
  // The supervisor's own folder is not a place to work in
  const sections = useMemo(() => directorySections(sorted, resumable.filter(r => !r.cwd.endsWith('/agent-mcr/supervisor')), pinned), [sorted, resumable, pinned]);
  // Of the folders that only have history, the most recently used few are listed until more are asked for
  const recentHistory = sections.filter(d => !d.sessions.length && !d.pinned).sort((a, b) => b.latest - a.latest).slice(0, HISTORY_FOLDERS);
  const shown = allHistory ? sections : sections.filter(d => d.sessions.length || d.pinned || recentHistory.includes(d));
  const names = new Map(hosted.map(h => [h.id, hostedLabel(h)]));
  const row = (h: Hosted) => {
    const state = hostedState(h);
    const label = hostedLabel(h);
    const detail = h.exit
      ? `exited ${h.exit.signal ? `by ${h.exit.signal}` : `with ${h.exit.code}`} · ${formatAge(h.exit.at)}`
      : [h.openTasks ? `${h.openTasks} task${h.openTasks > 1 ? 's' : ''}` : '', h.unread ? `${h.unread} unread` : '', referenced === h.id ? 'reference copied' : ''].filter(Boolean).join(' · ');
    const subs = (h.subagents ?? []).filter(a => !a.finished);
    const shells = h.exit ? [] : h.shells ?? [];
    return <li key={h.id} className={[h.id === selected ? 'selected' : '', needsYou(h) ? 'needs-you' : '', !needsYou(h) && (state === 'idle' || h.exit) && !shells.length ? 'idle' : ''].filter(Boolean).join(' ')}>
      <button className="hs-item" onClick={() => select(h.id)} title={`${STATE_LABEL[state]} · pid ${h.pid ?? '?'}\n${h.argv.join(' ')}\n${h.cwd}${h.peers?.length ? `\nIn contact with: ${h.peers.map(id => names.get(id) ?? id).join(', ')}` : ''}`}>
        <span className={`hs-dot ${state}`} aria-label={STATE_LABEL[state]}/>
        <span className="hs-item-text">
          <strong><AgentMark profile={h.harness?.profile || h.meta.profile || ''}/> {label}</strong>
          {detail && <small>{detail}</small>}
          {needsYou(h) && <small className="hs-needs">{h.harness?.attention?.text}</small>}
          {!h.exit && h.harness?.status && <small className="hs-status">{h.harness.status}</small>}
        </span>
      </button>
      <RowMenu label={`Actions for ${label}`} actions={actions(h)}/>
      {shells.length > 0 && <ul className="hs-subs hs-shells" aria-label={`Running shells of ${label}`}>
        {shells.map(sh => {
          const now = Date.now();
          const health = shellHealth(sh, now);
          const quiet = health === 'quiet' ? runningFor(sh.quietSince ?? now, now) : '';
          const why = health === 'stopped' ? 'Suspended: it is not running until it is continued.'
            : health === 'quiet' ? `No processor use for ${quiet}: it may be waiting (the network, a lock, a sleep) or stuck.`
            : 'Using the processor: alive.';
          return <li key={sh.pid} className={health} title={`${sh.command}\npid ${sh.pid} · running for ${runningFor(sh.started, now)}${sh.cpu !== undefined ? ` · ${sh.cpu < 10 ? sh.cpu.toFixed(1) : Math.round(sh.cpu)}s of processor time` : ''}\n${why}`}>
            <Terminal size={11} aria-label={`${health} shell`}/>
            <span className="hs-item-text"><strong>{sh.command}</strong></span>
            <small>{health === 'stopped' ? 'stopped · ' : quiet ? `quiet ${quiet} · ` : ''}{runningFor(sh.started, now)}</small>
          </li>;
        })}
      </ul>}
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
        {supervisor && <RowMenu label="Actions for the supervisor" actions={actions(supervisor)}/>}
      </div>
      <form className="hs-add" onSubmit={e => { e.preventDefault(); addFolder(cwd); }}>
        <input aria-label="Add a folder" list="hs-folders" value={cwd} onChange={e => setCwd(e.target.value)} placeholder="Add a folder to work in…"/>
        <datalist id="hs-folders">{suggestions.map(d => <option key={d} value={d}/>)}</datalist>
        <button type="button" title="Choose a folder" aria-label="Choose a folder" onClick={async () => { try { const dir = await pickDirectory(); if (dir) addFolder(dir); } catch (e) { setError(err(e)); } }}><FolderOpen size={14}/></button>
        <button type="submit" title="Add this folder as a section" aria-label="Add folder" disabled={!cwd.trim()}><FolderPlus size={14}/></button>
      </form>
      {waiting.length > 0 && <p className="hs-attention" role="status"><BellRing size={12}/> {waiting.length === 1 ? '1 session is waiting for you' : `${waiting.length} sessions are waiting for you`}</p>}
      {error && <div className="hs-error" role="alert">{error}</div>}
      <ul>
        {shown.map(d => {
          const name = tildePath(d.path, home);
          const open = earlierOpen.has(d.path);
          return <li key={d.path} className={`hs-dir${d.sessions.some(h => !h.exit) ? ' live' : ''}`} aria-label={`Folder ${d.path}`}>
            <header className="hs-dir-head">
              <span className="hs-dir-path" title={d.path}>{shortPath(name)}</span>
              <span className="hs-dir-rule"/>
              <RowMenu className="hs-dir-tools" label={`Start a session in ${d.path}`} title={`Start a session in ${name}`} icon={<Plus size={13}/>} disabled={!status || starting}
                actions={START.map(([profile, what]) => ({ label: what, icon: <AgentMark profile={profile} size={13}/>, run: () => void start(profile, d.path) }))}/>
              {onSearch && <button type="button" className="hs-dir-start" title={`Search the history of ${name}`} aria-label={`Search the history of ${d.path}`} onClick={() => onSearch(d.path)}><Search size={12}/></button>}
              {d.pinned && !d.sessions.length && <button type="button" className="hs-dir-start" title="Remove this folder from the list" aria-label={`Remove folder ${d.path}`} onClick={() => pin(pinned.filter(x => x !== d.path))}><X size={12}/></button>}
            </header>
            {d.sessions.length > 0 && <ul aria-label={`Sessions in ${d.path}`}>{d.sessions.map(row)}</ul>}
            {d.earlier.length > 0 && <div className="hs-earlier">
              <button type="button" className="hs-earlier-toggle" aria-expanded={open} onClick={() => setEarlierOpen(old => { const next = new Set(old); if (next.has(d.path)) next.delete(d.path); else next.add(d.path); return next; })}>
                {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<History size={11}/> Earlier · {d.earlier.length} · last {formatAge(d.earlier[0].modified)}
              </button>
              {open && <ul aria-label={`Earlier sessions in ${d.path}`}>
                {d.earlier.slice(0, 12).map(r => <li key={r.id}>
                  <button type="button" className="hs-item hs-resume" disabled={!status || starting} title={`Continue this ${r.agent === 'claude' ? 'Claude' : 'Codex'} session here${maybeOpenElsewhere(r, Date.now()) ? '. It changed minutes ago: close it in its other terminal first' : ''}\n${r.id}`} onClick={() => void resume(r.id)}>
                    <span className="hs-item-text"><strong><AgentMark profile={r.agent}/> {titles[r.id] || `${r.agent === 'claude' ? 'Claude' : 'Codex'} session`}</strong></span>
                    <small>{formatAge(r.modified)}{maybeOpenElsewhere(r, Date.now()) ? ' · open elsewhere?' : ''}</small>
                  </button>
                </li>)}
                {d.earlier.length > 12 && <li className="hs-earlier-more">{d.earlier.length - 12} older: use search</li>}
              </ul>}
            </div>}
          </li>;
        })}
      </ul>
      {sections.length > shown.length && <button type="button" className="hs-more-folders" onClick={() => setAllHistory(true)}>{sections.length - shown.length} more folders with history</button>}
      {!sections.length && status && <p className="hs-empty">No sessions yet. Add a folder above and start an agent in it; it keeps running when you close the app.</p>}
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
