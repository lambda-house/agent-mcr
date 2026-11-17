import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronRight, ClipboardList, MessageSquare, Play, RefreshCw, Search, Shield, Terminal, X, Zap } from 'lucide-react';
import { compact, family, origin, within, sessionDirectories, matchesActivity, matchesSession, sessionApi, sessionKey, sumUsage, totalTokens, type SessionEvent, type Session, type Snapshot } from '../utils/sessions';
import { isTauri } from '../utils/tauri';
import { formatAge } from '../utils/agent';
import '../styles/sessions.css';
import SessionTree from './SessionTree';
import WorkspaceSwitch from './WorkspaceSwitch';
import SessionResults from './SessionResults';
import { harnessApi, slackApi } from '../utils/harness';
import SessionMemoryBrowser from './SessionMemoryBrowser';
import SessionAgentAccess from './SessionAgentAccess';
import LiveWorkspace from './LiveWorkspace';
import BoardView from './BoardView';
import SlackView from './SlackView';

const VIEW_KEY = 'agent-mcr.sessions.view';
type View = 'live' | 'history' | 'board' | 'slack';
function savedView(): View {
  try { const v = localStorage.getItem(VIEW_KEY); return v === 'history' || v === 'board' || v === 'slack' ? v : 'live'; } catch { return 'live'; }
}

const empty: Snapshot = { sessions: [], errors: [], scannedFiles: 0, pendingFiles: 0, indexedAt: 0 };
const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const label = (s: Session) => s.title || s.name || s.id;
const date = (s: string) => s ? new Date(s).toLocaleString() : 'Unknown';
function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="sc-metric"><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}
export default function SessionWorkspace({ onClose, active = true }: { onClose: () => void; active?: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [view, setViewState] = useState<View>(savedView);
  const [focus, setFocus] = useState<{ id: string; at: number }>();
  // Posts that wait for the person's approval: shown on the Slack tab from every view
  const [slackWaiting, setSlackWaiting] = useState(0);
  useEffect(() => {
    if (!active || !isTauri()) return;
    const look = () => { if (!document.hidden) slackApi.status().then(s => setSlackWaiting(s.counts.waiting)).catch(() => {}); };
    look();
    const timer = setInterval(look, 4000);
    return () => clearInterval(timer);
  }, [active]);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience only */ } };
  const [data, setData] = useState<Snapshot>(empty);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [focusedEvidence, setFocusedEvidence] = useState<{ session: string; event: SessionEvent } | null>(null);
  const [olderEvents, setOlderEvents] = useState<SessionEvent[] | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [detail, setDetail] = useState<Session | null>(null);
  const [selected, setSelected] = useState(''); const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('all'); const [directory, setDirectory] = useState('');
  const [role, setRole] = useState('all'); const [activeSince, setActiveSince] = useState(''); const [inactiveSince, setInactiveSince] = useState(''); const [inactiveMinutes, setInactiveMinutes] = useState(''); const [activeMinutes, setActiveMinutes] = useState('');
  const [agentAccess, setAgentAccess] = useState(false);
  const [userMemories, setUserMemories] = useState(false); const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('activity'); const [eventFilter, setEventFilter] = useState('all');
  const inflight = useRef(false); const mounted = useRef(true); const contextVersion = useRef(0);
  const refresh = useCallback(async () => {
    if (inflight.current) return; inflight.current = true; setBusy(true);
    try { const result = await sessionApi.snapshot(); if (mounted.current) { setData(result); setError(''); setSelected(s => s || (result.sessions[0] ? sessionKey(result.sessions[0]) : '')); } }
    catch(e) { if(mounted.current) setError(err(e)); }
    finally { inflight.current = false; if(mounted.current) setBusy(false); }
  }, []);
  useEffect(() => { mounted.current = true; if (!isTauri()) { setEnabled(false); return; } sessionApi.access().then(setEnabled).catch(e => setError(err(e))); return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!enabled || !active) return; void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000); return () => clearInterval(timer); }, [enabled, active, refresh]);
  useEffect(() => {
    if (!enabled || !active || !data.pendingFiles) return;
    const timer = setTimeout(() => { if (!document.hidden) void refresh(); }, 150);
    return () => clearTimeout(timer);
  }, [enabled, active, data.indexedAt, data.pendingFiles, refresh]);
  useEffect(() => { setOlderEvents(null); contextVersion.current++; }, [selected]);
  const filtered = useMemo(() => data.sessions.filter(s =>
    (provider === 'all' || s.provider === provider)
    && (role === 'all' || origin(s) === role)
    && (!directory || sessionDirectories(s).some(path => within(path,directory)))
    && matchesActivity(s,{activeSince:Date.parse(activeSince),inactiveSince:Date.parse(inactiveSince),activeMinutes:Number(activeMinutes),inactiveMinutes:Number(inactiveMinutes)})
    && (filter === 'all' || (filter === 'recent' ? Date.now()-s.modified<86400000 : filter === 'roots' ? !s.parentId : s.status===filter))
    && matchesSession(s,query)), [data,provider,role,directory,activeSince,inactiveSince,activeMinutes,inactiveMinutes,filter,query]);
  useEffect(() => {
    if (!active) return;
    const summary = data.sessions.find(s => sessionKey(s) === selected);
    if (!summary) { setDetail(null); return; }
    let cancelled = false;
    sessionApi.detail(summary.provider, summary.id).then(s => { if (!cancelled) setDetail({ ...s, status: summary.status }); }).catch(e => { if (!cancelled) setError(err(e)); });
    return () => { cancelled = true; };
  }, [selected, data, active]);
  const chosen = detail && sessionKey(detail) === selected ? detail : data.sessions.find(s => sessionKey(s) === selected);
  const usage = sumUsage(filtered); const working = filtered.filter(s => s.status === 'working').length;
  const events = focusedEvidence?.session === selected ? [focusedEvidence.event] : olderEvents ?? chosen?.events ?? [];
  const descendants = chosen ? family(data.sessions,chosen) : [];
  // Titles for the Live view's earlier sessions, which only know ids
  const titles = useMemo(() => Object.fromEntries(data.sessions.filter(s => !s.parentId && s.title).map(s => [s.id, s.title])), [data.sessions]);
  const searchFolder = (path: string) => { setDirectory(path); setView('history'); };
  const filtersOn = [provider !== 'all', role !== 'all', filter !== 'all', !!(activeSince || inactiveSince || activeMinutes || inactiveMinutes)].filter(Boolean).length;
  const clearFilters = () => { setActiveSince(''); setInactiveSince(''); setInactiveMinutes(''); setActiveMinutes(''); setDirectory(''); setRole('all'); setProvider('all'); setFilter('all'); setQuery(''); };
  /** Continue an earlier session in a hosted terminal, in its own folder. */
  const resumeLive = async (s: Session) => {
    try { await harnessApi.spawn('', '', 120, 32, s.id); setView('live'); } catch (e) { setError(err(e)); }
  };
  const recentDirectories = useMemo(() => [...new Set([...data.sessions].sort((a, b) => b.modified - a.modified).map(s => s.cwd).filter(Boolean))].slice(0, 30), [data.sessions]);
  return <section className="session-cockpit">
    <header className="sc-topbar">
      <WorkspaceSwitch active="sessions" onChange={workspace => { if (workspace === 'documents') onClose(); }}/>
      <nav className="hs-view-switch" aria-label="Sessions view">
        <button type="button" aria-current={view === 'live' ? 'page' : undefined} onClick={() => setView('live')}><Terminal size={13}/> Live</button>
        <button type="button" aria-current={view === 'history' ? 'page' : undefined} onClick={() => setView('history')} title="Find an earlier session: by text, folder, agent or time"><Search size={13}/> Search</button>
        <button type="button" aria-current={view === 'board' ? 'page' : undefined} onClick={() => setView('board')} title="What sessions reported to you, and the notes they left for each other"><ClipboardList size={13}/> Board</button>
        <button type="button" aria-current={view === 'slack' ? 'page' : undefined} onClick={() => setView('slack')} title="Slack: what is listened to, what sessions may post, and posts that wait for your approval"><MessageSquare size={13}/> Slack <small className="hs-preview">Preview</small>{slackWaiting > 0 && <span className="hs-slack-badge" aria-label={`${slackWaiting} waiting for your approval`}>{slackWaiting}</span>}</button>
      </nav>
      <div className="sc-top-actions">
        {enabled && <><button onClick={() => void refresh()} disabled={busy} aria-label="Refresh sessions" title={busy ? 'Indexing transcripts…' : `Refresh · updated ${formatAge(data.indexedAt)}`}><RefreshCw size={14}/></button><button onClick={() => setUserMemories(true)}>User memories</button><button onClick={() => setAgentAccess(true)}>Agent access</button></>}
      </div>
      {enabled && <details className="sc-summary">
        <summary><span className="sc-summary-working">{working} working</span><span> · {filtered.length.toLocaleString()} sessions</span><ChevronRight size={12}/></summary>
        <div className="sc-summary-popover">
          <Metric label="Observed working" value={String(working)} hint="Recent transcript activity; not process liveness"/>
          <Metric label="Sessions & agents" value={filtered.length.toLocaleString()} hint={`${filtered.filter(s => origin(s)==='human').length} human · ${filtered.filter(s => origin(s)==='subagent').length} subagents`}/>
          <Metric label="Recorded tokens" value={compact(totalTokens(usage))} hint={`${compact(usage.input)} input · ${compact(usage.output)} output · lifetime usage of matching sessions`}/>
          <Metric label="Cached input" value={compact(usage.cached)} hint={`${usage.input ? Math.round(usage.cached / usage.input * 100) : 0}% of input · included in token total`}/>
          {data.pendingFiles > 0 && <p>History is still indexing; totals are partial.</p>}
        </div>
      </details>}
    </header>
    <div className="hs-live-wrap" hidden={view !== 'live'}><LiveWorkspace active={active && view === 'live'} recentDirectories={recentDirectories} titles={titles} onSearch={enabled ? searchFolder : undefined} focus={focus}/></div>
    {view === 'slack' && <SlackView active={active} onOpen={id => { setFocus({ id, at: Date.now() }); setView('live'); }} onWaiting={setSlackWaiting}/>}
    {view === 'board' && <BoardView active={active} onOpen={id => { setFocus({ id, at: Date.now() }); setView('live'); }}/>}
    {view === 'history' && <>
    {error && <div className="sc-banner" role="alert">{error}</div>}
    {!enabled ? <div className="sc-welcome"><div className="sc-logo"><Bot size={36}/></div><p className="sc-eyebrow">YOUR AGENTIC LANDSCAPE</p><h1>See the work.<br/>Follow every agent.</h1><p>Codex and Claude sessions, their agents, models, tokens, tools and linked work. One view across all recorded workspaces on this machine.</p>
      <button className="sc-primary" disabled={!isTauri() || enabled === null} onClick={async () => { try { setEnabled(await sessionApi.enable()); } catch(e) {setError(err(e));} }}><Shield size={16}/>{isTauri() ? 'Enable session access' : 'Open the desktop app to connect local sessions'}</button><small>Local transcripts · no transcript edits · remote connections on demand</small></div> : <>
      <div className="sc-body ss-body"><aside className="sc-session-list ss-list" aria-label="Session search">
        <div className="sc-search ss-search"><Search size={14}/><input aria-label="Search sessions" placeholder="Find a task, ticket, model or tool…" value={query} onChange={e => setQuery(e.target.value)}/></div>
        <details className="ss-filters">
          <summary><span>Filters{filtersOn ? ` · ${filtersOn} on` : ''}</span><span className="ss-count">{filtered.length.toLocaleString()} sessions</span><ChevronRight size={12}/></summary>
          <div className="ss-filter-fields">
            <select aria-label="Provider" value={provider} onChange={e => setProvider(e.target.value)}><option value="all">All providers</option><option value="codex">Codex</option><option value="claude">Claude</option></select>
            <select aria-label="Session origin" value={role} onChange={e => setRole(e.target.value)}><option value="all">Humans & agents</option><option value="human">Human sessions</option><option value="subagent">Subagents</option><option value="automation">Automation / exec</option><option value="unknown">Unknown origin</option></select>
            <select aria-label="Activity filter" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All activity</option><option value="working">Observed working</option><option value="recent">Last 24 hours</option><option value="roots">Root sessions</option><option value="stale">Stale / unconfirmed</option><option value="idle">Idle</option><option value="interrupted">Interrupted</option></select>
            <label>Active in the last<select aria-label="Active in the last" value={activeMinutes} onChange={e=>setActiveMinutes(e.target.value)}><option value="">Any time</option><option value="5">5 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="1440">1 day</option><option value="10080">7 days</option></select></label>
            <label>No activity for<select aria-label="No activity for" value={inactiveMinutes} onChange={e=>setInactiveMinutes(e.target.value)}><option value="">Any duration</option><option value="5">5 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="1440">1 day</option><option value="10080">7 days</option></select></label>
            <label>Active since<input aria-label="Active since" type="datetime-local" value={activeSince} onChange={e=>setActiveSince(e.target.value)}/></label>
            <label>Inactive since<input aria-label="Inactive since" type="datetime-local" value={inactiveSince} onChange={e=>setInactiveSince(e.target.value)}/></label>
            <p className="sc-time-help">Filters combine using last recorded activity. Dates use local time.</p>
          </div>
        </details>
        {(directory || filtersOn > 0 || query) && <div className="ss-active">
          {directory && <span className="ss-chip" title={directory}>in {directory.replace(/^\/(Users|home)\/[^/]+/, '~')}<button aria-label="Search all folders" title="Search all folders" onClick={() => setDirectory('')}><X size={10}/></button></span>}
          <button className="sc-clear-filters" onClick={clearFilters}><X size={12}/> Clear</button>
        </div>}
        <SessionResults all={data.sessions} matches={filtered} selected={selected} select={setSelected} directory={directory} narrow={setDirectory}/>
        {!filtered.length && <div className="sc-empty">{busy ? 'Indexing transcripts…' : 'No sessions match these filters.'}</div>}
      </aside>
      <main className="sc-detail">{chosen ? <><div className="sc-detail-heading"><div className="sc-session-meta"><span className={`sc-provider ${chosen.provider}`}>{chosen.provider}</span><span className={`sc-status ${chosen.status}`}>{chosen.status}</span><span>{origin(chosen)==='human' ? 'Human session' : origin(chosen)} · {chosen.name}</span></div><h2 title={label(chosen)}>{label(chosen)}</h2><p title={chosen.cwd}>{chosen.cwd}</p><div className="sc-detail-info"><span><Zap size={14}/>{chosen.model || 'Unknown model'} {chosen.effort && `· ${chosen.effort}`}</span><span>{compact(totalTokens(chosen.usage))} recorded tokens</span><span>{chosen.eventCount.toLocaleString()} events</span>{!chosen.parentId && isTauri() && <button className="ss-resume" title="Continue this session in a hosted terminal, in its folder" onClick={() => void resumeLive(chosen)}><Play size={11}/> Resume in Live</button>}</div></div>
        <nav className="sc-tabs" aria-label="Session details">{['activity','agents','usage','memories','linked work'].map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}{t === 'agents' && <span>{descendants.length - 1}</span>}</button>)}</nav>
        <div className="sc-detail-content">
        {tab === 'activity' && <>{focusedEvidence?.session === selected && <button onClick={()=>setFocusedEvidence(null)}>Back to activity</button>}<div className="sc-section-row"><h3>Activity <span className="sc-activity-count">{events.length} / {chosen.eventCount} · {olderEvents ? 'earlier' : 'latest'} · newest first</span></h3><select title="Message previews are capped at 12,000 characters" aria-label="Event type" value={eventFilter} onChange={e => setEventFilter(e.target.value)}>{['all','user','assistant','tool','result','error'].map(t => <option key={t}>{t}</option>)}</select></div>
          <div className="sc-history-actions">{olderEvents && <button onClick={() => setOlderEvents(null)}>Back to latest</button>}{events[0]?.seq > 1 && <button disabled={historyBusy} onClick={async () => { const version=contextVersion.current; setHistoryBusy(true); try { const page=await sessionApi.events(chosen.provider,chosen.id,events[0].seq-1); if(contextVersion.current===version) setOlderEvents(page); } catch(e) {setError(err(e));} finally {setHistoryBusy(false);} }}>{historyBusy ? 'Loading earlier activity…' : 'Earlier activity'}</button>}</div>
          {[...events].reverse().filter(e => eventFilter === 'all' || e.kind === eventFilter).map((e,i) => <article className={`sc-event ${e.kind}`} key={`${chosen.id}-${e.at}-${i}`}><div className="sc-event-dot"/><header><strong>{e.tool || e.kind}</strong><time>{date(e.at)}</time></header>{e.kind === 'tool' || e.kind === 'result' ? <details><summary>{e.text.slice(0,180)}</summary><pre>{e.text}</pre></details> : e.text.length > 400 ? <details className="sc-message"><summary>{e.text.slice(0,240)}</summary><p>{e.text}</p></details> : <p>{e.text}</p>}</article>)}</>}
        {tab === 'agents' && <><h3>Session hierarchy</h3>{chosen.parentId && <p>Parent: <button className="sc-text-button" onClick={() => setSelected(`${chosen.provider}:${chosen.parentId}`)}>{chosen.parentId}</button></p>}{chosen.forkedFrom && <p>Forked from <button className="sc-text-button" onClick={()=>setSelected(`${chosen.provider}:${chosen.forkedFrom}`)}>{chosen.forkedFrom}</button></p>}<p className="sc-note">This session and descendants: {compact(totalTokens(sumUsage(descendants)))} tokens. Ancestors appear for context and are excluded from this total.</p><SessionTree all={data.sessions} matches={descendants} selected={selected} select={setSelected}/></>}
        {tab === 'memories' && <SessionMemoryBrowser key={sessionKey(chosen)} session={chosen}/>}
        {tab === 'usage' && <><h3>Recorded usage</h3><p className="sc-note">Lifetime of this session. Cached and cache-write input are included in input; reasoning is included in output. Token counts are not a monetary bill. Missing telemetry is shown as unknown.</p>{!chosen.usageKnown ? <p>No usage reported in this transcript.</p> : <><div className="sc-usage-grid">{Object.entries(chosen.usage).map(([k,v]) => <Metric key={k} label={k.replace('cacheWrite','cache write')} value={v.toLocaleString()} hint="tokens"/>)}</div><h3>By model</h3><table><thead><tr><th>Model</th><th>Input</th><th>Cached</th><th>Output</th></tr></thead><tbody>{Object.entries(chosen.models).map(([m,u]) => <tr key={m}><td>{m || 'Unattributed'}</td><td>{compact(u.input)}</td><td>{compact(u.cached)}</td><td>{compact(u.output)}</td></tr>)}</tbody></table></>}<h3>Tools used</h3>{Object.entries(chosen.tools).sort((a,b) => b[1]-a[1]).map(([tool,count]) => <div className="sc-tool-row" key={tool}><code>{tool}</code><span>{count}</span></div>)}<details className="sc-provenance"><summary>Source & accounting provenance</summary><p>{chosen.source}</p><p>Started {date(chosen.started)} · updated {date(chosen.updated)}</p><p>{chosen.provider === 'codex' ? 'Unique response usage records for this thread; older transcripts fall back to cumulative usage differences.' : 'Unique message IDs; repeated usage fragments are counted by positive increments.'}</p><p>Skipped malformed records: {chosen.malformedLines}</p></details></>}
        {tab === 'linked work' && <><h3>Ticket mentions</h3><p className="sc-note">Keys found in messages and tool activity. A mention is evidence of a reference, not an assignment.</p><div className="sc-ticket-list">{chosen.tickets.map(key => <code key={key}>{key}</code>)}</div>{!chosen.tickets.length && <p>No ticket mentions found.</p>}<h3>Memory tools observed</h3>{chosen.memoryRefs.length ? chosen.memoryRefs.map(r => <code className="sc-memory-ref" key={r}>{r}</code>) : <p className="sc-note">No named memory calls observed. Calls through shell wrappers may not be identifiable.</p>}</>}
        </div></> : <div className="sc-empty"><Bot size={32}/><h2>Select a session</h2><p>Inspect its activity, agents and linked work.</p></div>}</main></div>
      <footer className="sc-footer"><span title={data.cachePath || 'No persistent cache'}><i className="sc-local-dot"/> {data.cachePath ? 'SQLite index' : 'In-memory index'} · {data.restoredFiles || 0} restored · {data.pendingFiles ? `${data.pendingFiles} files still indexing · totals partial` : 'history indexed'} · {compact(data.bytesRead || 0)} bytes read this scan · {data.errors.length} warnings</span><button onClick={async () => { try { await sessionApi.disable(); setEnabled(false); setData(empty); } catch(e) {setError(err(e));} }}>Revoke session access</button></footer>
      {data.errors.length > 0 && <details className="sc-errors"><summary>Index warnings</summary>{data.errors.map((e,i) => <p key={i}>{e}</p>)}</details>}
    </>}</>}{agentAccess && <SessionAgentAccess close={() => setAgentAccess(false)} directory={directory} selected={chosen} inspect={(key,event)=>{setSelected(key);setTab('activity');setEventFilter('all');setAgentAccess(false);setFocusedEvidence({session:key,event});}}/>}{userMemories && <div className="sc-dialog-backdrop"><section className="sc-dialog sc-memory-dialog" role="dialog" aria-modal="true" aria-label="User memories"><header><h2>User memories</h2><button onClick={()=>setUserMemories(false)} aria-label="Close user memories"><X size={18}/></button></header><SessionMemoryBrowser/></section></div>}</section>;
}
