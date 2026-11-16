import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, BellRing, ChevronDown, ChevronRight, Copy, Folder, FolderOpen, History, MoreHorizontal, Play, Plus, Radar, RotateCw, Search, Terminal, X } from 'lucide-react';
import { Button, Dialog } from '@teob/ui';
import TerminalPane from './TerminalPane';
import AgentMark from './AgentMark';
import SessionStats from './SessionStats';
import SessionMetrics, { useSessionMetrics } from './SessionMetrics';
import { canRestart, directorySections, harnessApi, hostedLabel, hostedState, isSupervisor, maybeOpenElsewhere, runningFor, sessionReference, shellHealth, STATE_LABEL, subagentActive, type HarnessStatus, type Hosted, type Resumable } from '../utils/harness';
import { applyLayoutPreset, closeLeaf, createInitialLayout, findLeaf, findLeafByItem, listLeaves, removeSessionFromLayout, replaceSessionInLayout, setLeafItem, setSplitRatio, splitLeaf, type LayoutPreset, type PaneItem, type PaneNode } from '../utils/paneLayout';
import { pickDirectory, isTauri } from '../utils/tauri';
import { formatAge } from '../utils/agent';
import { pluginRegistry, usePluginVersion, type LiveControllerContext } from '../plugins';
import '../styles/harness.css';

const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const base = (path: string) => path.split('/').filter(Boolean).pop() || path;
const PINNED_KEY = 'hs-dirs';
const START: [string, string][] = [['claude', 'Claude Code'], ['codex', 'Codex']];
/** Folders with only history shown before "more" is asked for. */
const HISTORY_FOLDERS = 6;

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

function PaneSlot({ sessionId, registerSlot }: { sessionId: string; registerSlot: (id: string, el: HTMLElement | null) => void }) {
  const ref = useCallback((el: HTMLElement | null) => registerSlot(sessionId, el), [sessionId, registerSlot]);
  return <div className="hs-pane-slot" ref={ref}/>;
}

function HiddenPaneSlot({ sessionId, registerSlot }: { sessionId: string; registerSlot: (id: string, el: HTMLElement | null) => void }) {
  const ref = useCallback((el: HTMLElement | null) => registerSlot(sessionId, el), [sessionId, registerSlot]);
  return <div className="hs-pane" hidden ref={ref}/>;
}

/**
 * Agent terminals hosted by the runner. They keep running when this view, the
 * Sessions workspace or the whole app closes (docs/AGENT_HARNESS_DESIGN.md, D1).
 */
export default function LiveWorkspace({ active, recentDirectories, titles = {}, onSearch }: {
  active: boolean; recentDirectories: string[];
  /** Titles of earlier sessions by conversation id, when the Sessions index has them */
  titles?: Record<string, string>;
  /** Open the search view narrowed to a folder */
  onSearch?: (directory: string) => void;
}) {
  const metrics = useSessionMetrics(active);
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [hosted, setHosted] = useState<Hosted[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [opened, setOpened] = useState<string[]>([]);
  const [layout, setLayout] = useState<PaneNode>(() => createInitialLayout());
  const [focusedPane, setFocusedPane] = useState('p1');
  const paneSeq = useRef(2);
  const splitSeq = useRef(1);
  const [slotEls, setSlotEls] = useState<Record<string, HTMLElement | null>>({});
  const registerSlot = useCallback((key: string, el: HTMLElement | null) => {
    setSlotEls(prev => prev[key] === el ? prev : { ...prev, [key]: el });
  }, []);
  const [profile, setProfile] = useState('claude');
  const [cwd, setCwd] = useState('');
  const [starting, setStarting] = useState(false);
  const [resumable, setResumable] = useState<Resumable[]>([]);
  const [resume, setResume] = useState('');
  const [copied, setCopied] = useState(false);
  const [referenced, setReferenced] = useState('');
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState('');
  const [pinned, setPinned] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(PINNED_KEY) || '[]') as string[]; } catch { return []; } });
  const pin = (next: string[]) => { setPinned(next); try { localStorage.setItem(PINNED_KEY, JSON.stringify(next)); } catch { /* not kept */ } };
  const [allHistory, setAllHistory] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(() => new Set<string>());
  // The usage pane beside the terminal: open or closed is this viewer's preference
  const [stats, setStats] = useState(() => { try { return localStorage.getItem('hs-stats') === '1'; } catch { return false; } });
  const toggleStats = () => setStats(on => { try { localStorage.setItem('hs-stats', on ? '0' : '1'); } catch { /* not kept */ } return !on; });
  // Sessions the person closed: once they have ended they leave the list too
  const closing = useRef(new Set<string>());
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
  const loadResumable = useCallback(() => {
    harnessApi.resumable()
      .then(r => { if (mounted.current) setResumable(r); })
      .catch(() => {});
  }, []);
  useEffect(() => { if (active && status) loadResumable(); }, [active, status, newAgentOpen, loadResumable]);

  usePluginVersion();

  const assignPaneItem = useCallback((leafId: string, item: PaneItem) => {
    if (item.kind === 'session' && item.id) {
      const sid = item.id;
      setOpened(o => o.includes(sid) ? o : [...o, sid]);
      setSelected(sid);
      pluginRegistry.emitEvent('session:selected', { id: sid });
    }
    setLayout(prev => {
      const existing = findLeafByItem(prev, item);
      const cleared = existing && existing.id !== leafId ? setLeafItem(prev, existing.id, null) : prev;
      return setLeafItem(cleared, leafId, item);
    });
    setFocusedPane(leafId);
  }, []);

  const openItem = useCallback((item: PaneItem) => {
    if (item.kind === 'session' && item.id) {
      const sid = item.id;
      setOpened(o => o.includes(sid) ? o : [...o, sid]);
      setSelected(sid);
      pluginRegistry.emitEvent('session:selected', { id: sid });
    }
    setLayout(prev => {
      const existing = findLeafByItem(prev, item);
      const focused = findLeaf(prev, focusedPane);
      if (existing && existing.id !== focusedPane) {
        if (focused && focused.item === null) {
          return setLeafItem(setLeafItem(prev, existing.id, null), focusedPane, item);
        }
        setFocusedPane(existing.id);
        return prev;
      }
      const targetId = focused ? focused.id : (listLeaves(prev)[0]?.id ?? 'p1');
      if (!focused) setFocusedPane(targetId);
      return setLeafItem(prev, targetId, item);
    });
  }, [focusedPane]);

  const clearItemFromLayout = useCallback((predicate: (item: PaneItem) => boolean) => {
    const walk = (node: PaneNode): PaneNode => {
      if (node.kind === 'leaf') {
        return node.item && predicate(node.item) ? { ...node, item: null } : node;
      }
      const a = walk(node.a);
      const b = walk(node.b);
      return a === node.a && b === node.b ? node : { ...node, a, b };
    };
    setLayout(walk);
  }, []);

  const select = (id: string) => {
    openItem({ kind: 'session', id });
    if (hosted.find(h => h.id === id)?.harness?.attention?.kind === 'notification') void harnessApi.ack(id).then(refresh).catch(() => {});
  };
  const focusPane = (leafId: string, item: PaneItem | null) => {
    setFocusedPane(leafId);
    if (item?.kind === 'session' && item.id) {
      setSelected(item.id);
      pluginRegistry.emitEvent('session:selected', { id: item.id });
    }
  };
  const splitPane = useCallback((leafId: string, dir: 'row' | 'col') => {
    const newLeafId = `p${paneSeq.current++}`;
    const newSplitId = `s${splitSeq.current++}`;
    setLayout(prev => splitLeaf(prev, leafId, dir, newLeafId, newSplitId, null));
    setFocusedPane(newLeafId);
    pluginRegistry.emitEvent('pane:split', { leafId, dir });
  }, []);
  const closePane = useCallback((leafId: string) => {
    setLayout(prev => {
      const next = closeLeaf(prev, leafId);
      const leaves = listLeaves(next);
      if (!leaves.some(l => l.id === focusedPane)) {
        const nextFocus = leaves[0];
        if (nextFocus) {
          setFocusedPane(nextFocus.id);
          setSelected(nextFocus.item?.kind === 'session' && nextFocus.item.id ? nextFocus.item.id : '');
        }
      } else if (leafId === focusedPane && leaves.length === 1) {
        const only = leaves[0].item;
        setSelected(only?.kind === 'session' && only.id ? only.id : '');
      }
      return next;
    });
    pluginRegistry.emitEvent('pane:closed', { leafId });
  }, [focusedPane]);
  const applyPreset = useCallback((preset: LayoutPreset) => {
    const visibleItems = listLeaves(layout).map(l => l.item).filter((x): x is PaneItem => !!x);
    const pool: PaneItem[] = [...visibleItems];
    for (const id of opened) {
      if (!pool.some(x => x.kind === 'session' && x.id === id)) pool.push({ kind: 'session', id });
    }
    const next = applyLayoutPreset(preset, pool, () => `p${paneSeq.current++}`, () => `s${splitSeq.current++}`);
    setLayout(next.layout);
    setFocusedPane(next.focusedPane);
    const firstItem = listLeaves(next.layout)[0]?.item;
    if (firstItem?.kind === 'session' && firstItem.id) setSelected(firstItem.id);
  }, [layout, opened]);

  const controller: LiveControllerContext = useMemo(() => ({
    active,
    hosted,
    opened,
    selected,
    layout,
    focusedPane,
    setFocusedPane,
    openItem,
    assignPaneItem,
    clearItemFromLayout,
    splitPane,
    closePane,
    applyPreset,
    openNewAgent: (targetLeafId?: string) => {
      if (targetLeafId) setFocusedPane(targetLeafId);
      setNewAgentOpen(true);
    },
    reportError: (msg: string) => setError(msg),
  }), [active, hosted, opened, selected, layout, focusedPane, openItem, assignPaneItem, clearItemFromLayout, splitPane, closePane, applyPreset]);
  const startDividerDrag = (splitId: string, dir: 'row' | 'col', e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = e.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const ratio = dir === 'row'
        ? (ev.clientX - rect.left) / Math.max(1, rect.width)
        : (ev.clientY - rect.top) / Math.max(1, rect.height);
      setLayout(prev => setSplitRatio(prev, splitId, ratio));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = dir === 'row' ? 'col-resize' : 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const waiting = useMemo(() => hosted.filter(h => !h.exit && h.harness?.attention), [hosted]);
  const suggestions = useMemo(() => [...new Set([status?.home ?? '', ...recentDirectories].filter(Boolean))].slice(0, 40), [status, recentDirectories]);
  // Rows keep their place: running ones in the order they were started, ended ones after them.
  // One that needs the person is marked, not moved. The supervisor has its own tile above the list
  const needsYou = (h: Hosted) => !h.exit && !!h.harness?.attention;
  const sorted = useMemo(() => hosted.filter(h => h.exit || !isSupervisor(h)).sort((a, b) => Number(!!a.exit) - Number(!!b.exit) || a.started - b.started || a.id.localeCompare(b.id)), [hosted]);
  const running = hosted.filter(h => !h.exit).length;

  const start = async (overrideProfile?: string, overrideCwd?: string, overrideResume?: string) => {
    const p = overrideProfile ?? profile;
    const dir = overrideCwd ?? cwd;
    const res = overrideResume ?? resume;
    if (!status || (!dir && !res) || starting) return;
    setStarting(true); setError('');
    try {
      const h = res ? await harnessApi.spawn('', '', 120, 32, res) : await harnessApi.spawn(p, dir, 120, 32);
      setResume(''); setNewAgentOpen(false); await refresh(); select(h.id); loadResumable();
      pluginRegistry.emitEvent('session:started', { id: h.id, profile: p, cwd: h.cwd });
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
  const forget = (id: string) => act(async () => {
    await harnessApi.forget(id);
    closing.current.delete(id);
    setOpened(o => o.filter(x => x !== id));
    setLayout(l => removeSessionFromLayout(l, id));
    setSelected(s => s === id ? '' : s);
    pluginRegistry.emitEvent('session:closed', { id });
  });
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
      setLayout(l => replaceSessionInLayout(l, h.id, fresh.id));
      if (selected === h.id) select(fresh.id);
      if (!fresh.resumed) setError(`${hostedLabel(h)} had no saved conversation to continue: it started fresh in the same folder.`);
    }).catch(e => { setError(err(e)); void refresh(); });
  };
  const actions = (h: Hosted): Action[] => [
    { label: 'Copy reference', icon: <Copy size={13}/>, run: () => copyReference(h) },
    ...(canRestart(h) ? [{ label: 'Restart (reload settings)', icon: <RotateCw size={13}/>, run: () => restart(h) }] : []),
    { label: h.exit ? 'Remove from the list' : 'Close session', icon: <X size={13}/>, run: () => close(h) },
  ];
  const names = new Map(hosted.map(h => [h.id, hostedLabel(h)]));
  const addFolder = (raw: string) => {
    const path = raw.trim().replace(/\/+$/, '') || '/';
    if (!path) return;
    if (!pinned.includes(path)) pin([...pinned, path]);
    setCwd('');
  };
  const home = status?.home ?? '';
  const shortPath = (p: string) => home && p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p === home ? '~' : p;
  const sections = useMemo(() => directorySections(sorted, resumable.filter(r => !r.cwd.endsWith('/agent-mcr/supervisor')), pinned), [sorted, resumable, pinned]);
  const recentHistory = sections.filter(d => !d.sessions.length && !d.pinned).sort((a, b) => b.latest - a.latest).slice(0, HISTORY_FOLDERS);
  const shown = allHistory ? sections : sections.filter(d => d.sessions.length || d.pinned || recentHistory.includes(d));

  const projectResumables = useMemo(() => resumable.filter(r => r.cwd === cwd), [resumable, cwd]);
  const selectedResume = useMemo(() => projectResumables.find(r => r.id === resume) ?? null, [projectResumables, resume]);
  const selectProjectCwd = (dir: string) => { setCwd(dir); setResume(''); };

  const formatPastLabel = (r: Resumable) => {
    const harnessName = r.agent === 'claude' ? 'Claude' : 'Codex';
    const raw = (r.title || titles[r.id] || '').trim();
    const openTag = maybeOpenElsewhere(r, Date.now()) ? ' · open?' : '';
    let role = r.role || '';
    let tags = [...(r.tags ?? [])];
    for (const enricher of pluginRegistry.getSessionEnrichers()) {
      const extra = enricher.enrichResumable?.(r);
      if (extra?.role && !role) role = extra.role;
      if (extra?.tags?.length) tags = [...new Set([...tags, ...extra.tags])];
    }
    return {
      title: raw || `${harnessName} session`,
      meta: `${formatAge(r.modified)} · ${harnessName}${openTag}`,
      role,
      chips: tags.slice(0, 3),
    };
  };
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
          <SessionMetrics hosted={h} data={metrics}/>
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

  const sidebarOverride = pluginRegistry.getOverride('live:sidebar');
  const newAgentOverride = pluginRegistry.getOverride('live:new-agent');
  const layoutBarOverride = pluginRegistry.getOverride('live:layout-bar');
  const paneTools = pluginRegistry.getOverride('live:pane-tools');
  // Without the Layouts plugin nothing can close a pane: fold back to one
  const panes = listLeaves(layout).length;
  useEffect(() => { if (!paneTools && panes > 1) applyPreset('1'); }, [paneTools, panes, applyPreset]);
  const sessionHeaderOverride = pluginRegistry.getOverride('live:session-header');

  const closeNewAgent = () => { setNewAgentOpen(false); setProjectFilter(''); setResume(''); };
  const defaultNewAgent = () => (
    <Dialog open={newAgentOpen} onClose={closeNewAgent} title="New agent" footer={<>
      <Button variant="ghost" size="sm" onClick={closeNewAgent}>Cancel</Button>
      <button type="button" className="hs-start hs-start--solid" disabled={!status || (!cwd && !selectedResume) || starting} onClick={() => void start(profile, cwd, selectedResume?.id ?? '')}>
        <Play size={12}/> {starting ? 'Starting…' : selectedResume ? `Resume ${selectedResume.agent === 'claude' ? 'Claude' : 'Codex'}` : `Start ${(status?.profiles ?? []).find(p => p.id === profile)?.label ?? profile}`}
      </button>
    </>}>
      <div className="hs-modal-body">
        <div className="hs-palette-search">
          <Search size={14} className="hs-search-icon"/>
          <input autoFocus value={projectFilter} onChange={e => setProjectFilter(e.target.value)} onKeyDown={e => {
            if (e.key === 'Enter' && projectFilter.trim()) {
              e.preventDefault();
              const q = projectFilter.trim();
              const first = suggestions.find(d => d.toLowerCase().includes(q.toLowerCase()));
              if (first) selectProjectCwd(first);
              else if (q.startsWith('/')) selectProjectCwd(q);
            }
          }} placeholder="Filter projects or paste a folder path…" aria-label="Filter projects"/>
          <button type="button" className="hs-palette-browse" onClick={async () => { try { const dir = await pickDirectory(); if (dir) { selectProjectCwd(dir); setProjectFilter(''); } } catch (e) { setError(err(e)); } }}><FolderOpen size={13}/> Browse…</button>
        </div>
        <div className="hs-split-picker">
          <div className="hs-split-col">
            <div className="hs-modal-label">Projects</div>
            <div className="hs-folder-list">
              {projectFilter.trim().startsWith('/') && !suggestions.includes(projectFilter.trim()) && (
                <button type="button" className={`hs-folder-opt${cwd === projectFilter.trim() ? ' active' : ''}`} onClick={() => selectProjectCwd(projectFilter.trim())}>
                  <Folder size={14}/>
                  <span className="hs-folder-opt-name">Custom path</span>
                </button>
              )}
              {suggestions.filter(d => !projectFilter.trim() || d.toLowerCase().includes(projectFilter.trim().toLowerCase())).map(dir => {
                const count = resumable.filter(r => r.cwd === dir).length;
                return <button key={dir} type="button" className={`hs-folder-opt${cwd === dir ? ' active' : ''}`} onClick={() => selectProjectCwd(dir)} title={dir}>
                  <Folder size={14}/>
                  <span className="hs-folder-opt-name">{base(dir)}</span>
                  {count > 0 && <span className="hs-folder-badge">{count}</span>}
                </button>;
              })}
            </div>
          </div>
          <div className="hs-split-col">
            <div className="hs-modal-label">Session in {cwd ? base(cwd) : 'project'}</div>
            <div className="hs-session-picks">
              <button type="button" className={`hs-session-pick${!selectedResume ? ' active' : ''}`} onClick={() => setResume('')}>
                <Plus size={14}/>
                <span className="hs-session-pick-text">
                  <strong>New session</strong>
                  <small>Start fresh</small>
                </span>
              </button>
              {projectResumables.map(r => {
                const info = formatPastLabel(r);
                return <button key={r.id} type="button" className={`hs-session-pick${resume === r.id ? ' active' : ''}`} onClick={() => setResume(r.id)} title={info.title}>
                  <AgentMark profile={r.agent} size={14}/>
                  <span className="hs-session-pick-text">
                    {info.role && <span className="hs-role-pill" title="Guessed from the tools the session used, not reported by the agent">{info.role}</span>}
                    <strong>{info.title}</strong>
                    <small>{info.meta}</small>
                    {info.chips.length > 0 && <span className="hs-session-chips">{info.chips.map(c => <span key={c}>{c}</span>)}</span>}
                  </span>
                </button>;
              })}
              {projectResumables.length === 0 && <p className="hs-modal-hint">No past sessions recorded for this folder yet.</p>}
            </div>
          </div>
        </div>
        {!selectedResume && <div className="hs-modal-sec">
          <div className="hs-modal-label">Harness</div>
          <div className="hs-pills" role="radiogroup" aria-label="Launch profile">
            {(status?.profiles ?? []).map(p => (
              <button key={p.id} type="button" role="radio" aria-checked={profile === p.id} className={`hs-pill${profile === p.id ? ' active' : ''}`} onClick={() => setProfile(p.id)} title={p.command}>
                <AgentMark profile={p.id} size={13}/>
                <span>{p.id === 'claude' ? 'Claude' : p.id === 'antigravity' ? 'Antigravity' : p.label}</span>
              </button>
            ))}
          </div>
        </div>}
        <input type="hidden" aria-label="Working folder" value={cwd} readOnly/>
      </div>
    </Dialog>
  );

  const defaultSidebar = () => (
    <aside className="hs-list" aria-label="Hosted sessions">
      {waiting.length > 0 && <p className="hs-attention" role="status"><BellRing size={12}/> {waiting.length === 1 ? '1 session is waiting for you' : `${waiting.length} sessions are waiting for you`}</p>}
      {error && <div className="hs-error" role="alert">{error}</div>}
      <div className={`hs-supervisor${supervisor ? ' running' : ''}${supervisor && supervisor.id === selected ? ' selected' : ''}${supervisor && needsYou(supervisor) ? ' needs-you' : ''}`}>
        <button type="button" className="hs-supervisor-open" disabled={!status || starting} onClick={() => void openSupervisor()}
          title="A Claude session wired to this harness: it sees and directs all the other sessions. It cannot answer their permission prompts; only you can.">
          <Radar size={15}/>
          <span className="hs-item-text">
            <strong>{supervisor ? 'Supervisor' : 'Open supervisor'}{supervisor && <span className={`hs-dot ${hostedState(supervisor)}`} aria-label={STATE_LABEL[hostedState(supervisor)]}/>}</strong>
            {supervisor && <SessionMetrics hosted={supervisor} data={metrics}/>}
            {supervisor && referenced === supervisor.id && <small>reference copied</small>}
            {supervisor && needsYou(supervisor) && <small className="hs-needs">{supervisor.harness?.attention?.text}</small>}
            {supervisor?.harness?.status && <small className="hs-status">{supervisor.harness.status}</small>}
          </span>
        </button>
        {supervisor && <RowMenu label="Actions for the supervisor" actions={actions(supervisor)}/>}
      </div>
      <div className="hs-add">
        <Button variant="ghost" size="sm" title="Choose a folder to work in" aria-label="Add project" onClick={async () => { try { const dir = await pickDirectory(); if (dir) addFolder(dir); } catch (e) { setError(err(e)); } }}><Plus size={14}/> Add project</Button>
      </div>
      <ul className="hs-dirs">
        {shown.map(d => {
          const name = d.path.split('/').filter(Boolean).pop() ?? d.path;
          const open = earlierOpen.has(d.path);
          return <li key={d.path} className={`hs-dir${d.sessions.length ? ' live' : ''}`}>
            <header className="hs-dir-head">
              <span className="hs-dir-path" title={d.path}>{shortPath(d.path)}</span>
              <span className="hs-dir-rule"/>
              <RowMenu className="hs-dir-tools" label={`Start a session in ${d.path}`} title={`Start a session in ${name}`} icon={<Plus size={13}/>} disabled={!status || starting}
                actions={START.map(([p, what]) => ({ label: what, icon: <AgentMark profile={p} size={13}/>, run: () => void start(p, d.path) }))}/>
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
                  <button type="button" className="hs-item hs-resume" disabled={!status || starting} title={`Continue this ${r.agent === 'claude' ? 'Claude' : 'Codex'} session here${maybeOpenElsewhere(r, Date.now()) ? '. It changed minutes ago: close it in its other terminal first' : ''}\n${r.id}`} onClick={() => void start(undefined, r.cwd, r.id)}>
                    <span className="hs-item-text"><strong><AgentMark profile={r.agent}/> {titles[r.id] || r.title || `${r.agent === 'claude' ? 'Claude' : 'Codex'} session`}</strong></span>
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
      {!sections.length && status && <p className="hs-empty">No sessions yet. Add a project above and start an agent in it; it keeps running when you close the app.</p>}
      {pluginRegistry.getSidebarSections().map(section => (
        <div key={section.id} className="hs-plugin-sidebar-section">
          {section.render(controller)}
        </div>
      ))}
      <footer className="hs-footer">
        <span>{status ? `Runner pid ${status.runner.pid} · ${running} running` : 'Connecting to the runner…'}</span>
        {status?.supervisorCommand && <button title={`Copy the command that gives an outside Claude Code the supervisor tools:\n${status.supervisorCommand}`} aria-label="Copy supervisor setup command" onClick={() => { void navigator.clipboard.writeText(status.supervisorCommand ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(e => setError(err(e))); }}><Copy size={12}/> {copied ? 'Copied' : 'Supervisor'}</button>}
        {status && <label className="hs-outside" title="Off: only the Supervisor session here has the supervisor tools. On: an agent you run outside Agent MCR and connected with the supervisor command has them too."><input type="checkbox" checked={!!status.outsideSupervisors} onChange={e => { void harnessApi.outsideSupervisors(e.target.checked).then(on => setStatus(s => s && { ...s, outsideSupervisors: on })).catch(x => setError(err(x))); }}/> outside agents</label>}
      </footer>
    </aside>
  );

  const sidebarController: LiveControllerContext = {
    ...controller,
    sidebarState: {
      status,
      resumable,
      titles,
      starting,
      error,
      copied,
      setCopied,
      setError,
      setStatus,
      selectSession: select,
      openSupervisor: () => void openSupervisor(),
      startSession: start,
      renderSessionRow: row,
      openNewAgentInDir: (dir: string) => { setCwd(dir); setNewAgentOpen(true); },
      renderSupervisorMenu: (sup: Hosted) => <RowMenu label="the supervisor" actions={actions(sup)}/>,
    },
  };

  return <div className="hs-live">
    {sidebarOverride ? sidebarOverride({ controller: sidebarController, defaultRender: defaultSidebar }) : defaultSidebar()}
    {newAgentOverride ? newAgentOverride({ open: newAgentOpen, onClose: closeNewAgent, controller, defaultRender: defaultNewAgent }) : defaultNewAgent()}
    <main className="hs-terminals">
      {(() => {
        const leaves = listLeaves(layout);
        const multiPane = leaves.length > 1;
        const visibleSessions = new Set(leaves.map(l => l.item?.kind === 'session' && l.item.id ? l.item.id : null).filter((x): x is string => !!x));
        const bgOpened = opened.filter(id => !visibleSessions.has(id) && hosted.some(h => h.id === id));
        const emptyActions = pluginRegistry.getEmptyActions();
        const emptyPaneOverride = pluginRegistry.getOverride('live:empty-pane');
        const renderNode = (node: PaneNode): React.ReactNode => {
          if (node.kind === 'split') {
            return (
              <div key={node.id} className={`hs-split hs-split--${node.dir}`}>
                <div className="hs-split-child" style={{ flex: node.ratio }}>{renderNode(node.a)}</div>
                <div className="hs-divider" role="separator" aria-orientation={node.dir === 'row' ? 'vertical' : 'horizontal'} onMouseDown={e => startDividerDrag(node.id, node.dir, e)}/>
                <div className="hs-split-child" style={{ flex: 1 - node.ratio }}>{renderNode(node.b)}</div>
              </div>
            );
          }
          const sessItem = node.item?.kind === 'session' ? node.item : null;
          const h = sessItem ? hosted.find(x => x.id === sessItem.id) : undefined;
          const pluginKind = node.item ? (node.item.kind === 'custom' ? node.item.type : node.item.kind) : '';
          const pluginPane = !h && pluginKind ? pluginRegistry.getPaneType(pluginKind) : undefined;
          const isFocused = node.id === focusedPane;
          const pickCandidates = hosted.filter(x => !x.exit && !visibleSessions.has(x.id));
          const defaultEmptyRender = () => (
            <>
              <header className="hs-pane-title hs-pane-title--empty">
                <span className="hs-empty-dot" aria-hidden="true"/>
                <strong>Empty pane</strong>
                <div className="hs-pane-tools">
                  {paneTools?.({ leafId: node.id, multiPane, controller })}
                </div>
              </header>
              <div className="hs-pane-empty">
                <div className="hs-empty-card">
                  <div className="hs-empty-head hs-empty-head--split">
                    <div>
                      <h3>Open in this pane</h3>
                      <p>Pick a workspace session or launch a new agent.</p>
                    </div>
                    <button
                      type="button"
                      className="hs-empty-new-btn"
                      onClick={() => {
                        setFocusedPane(node.id);
                        setNewAgentOpen(true);
                      }}
                    >
                      <Plus size={13} />
                      <span>New agent</span>
                    </button>
                  </div>

                  {emptyActions.length > 0 && (
                    <div className="hs-empty-actions">
                      {emptyActions.map((act) => (
                        <button
                          key={act.id}
                          type="button"
                          className="hs-empty-action"
                          onClick={() => act.onClick({ leafId: node.id, controller })}
                        >
                          {act.icon}
                          <span>
                            <strong>{act.title}</strong>
                            <small>{act.subtitle}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {pickCandidates.length > 0 ? (
                    <div className="hs-empty-groups">
                      {Array.from(
                        pickCandidates.reduce((map, cand) => {
                          const key = cand.cwd || '';
                          const list = map.get(key);
                          if (list) list.push(cand);
                          else map.set(key, [cand]);
                          return map;
                        }, new Map<string, typeof pickCandidates>())
                      ).map(([groupCwd, groupSessions]) => (
                        <div key={groupCwd || 'other'} className="hs-empty-group">
                          <div className="hs-empty-group-head">
                            <span className="hs-empty-group-name" title={groupCwd || 'Workspace'}>
                              {groupCwd ? base(groupCwd) : 'Workspace'}
                            </span>
                            <button
                              type="button"
                              className="hs-empty-group-new"
                              onClick={() => {
                                setFocusedPane(node.id);
                                if (groupCwd) setCwd(groupCwd);
                                setNewAgentOpen(true);
                              }}
                            >
                              <Plus size={11} />
                              <span>New</span>
                            </button>
                          </div>
                          <div className="hs-empty-group-list">
                            {groupSessions.map((cand) => {
                              const state = hostedState(cand);
                              return (
                                <button
                                  key={cand.id}
                                  type="button"
                                  className="hs-pane-pick"
                                  onClick={() =>
                                    assignPaneItem(node.id, { kind: 'session', id: cand.id })
                                  }
                                >
                                  <span className={`hs-dot ${state}`} />
                                  <AgentMark
                                    profile={cand.harness?.profile || cand.meta.profile || ''}
                                    size={13}
                                  />
                                  <strong>{isSupervisor(cand) ? 'Supervisor' : hostedLabel(cand)}</strong>
                                  <small className={`hs-pick-state hs-pick-state--${state}`}>
                                    {STATE_LABEL[state]}
                                  </small>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="hs-empty-none">No running sessions yet. Click New agent to start one.</p>
                  )}
                </div>
              </div>
            </>
          );

          return (
            <div key={node.id} className={`hs-pane${multiPane && isFocused ? ' focused' : ''}`} onMouseDown={() => focusPane(node.id, node.item)}>
              {h ? (() => {
                const defaultHeader = () => (
                  <header className="hs-pane-title">
                    <span className={`hs-dot ${hostedState(h)}`} aria-label={STATE_LABEL[hostedState(h)]}/>
                    <AgentMark profile={h.harness?.profile || h.meta.profile || ''}/>
                    <strong>{isSupervisor(h) ? 'Supervisor' : hostedLabel(h)}</strong>
                    <span title={h.cwd}>{h.cwd}</span>
                    <div className="hs-pane-tools">
                      <button type="button" className="hs-stats-toggle" aria-pressed={stats} title="Tokens, context size, tools and skills of this session" onClick={toggleStats}><BarChart3 size={13}/> Usage</button>
                      {paneTools?.({ leafId: node.id, multiPane, controller })}
                    </div>
                  </header>
                );
                return (
                  <>
                    {sessionHeaderOverride
                      ? sessionHeaderOverride({ session: h, leafId: node.id, multiPane, isFocused, statsOpen: stats, toggleStats, controller, defaultRender: defaultHeader })
                      : defaultHeader()}
                    <div className="hs-pane-body">
                      <PaneSlot sessionId={h.id} registerSlot={registerSlot}/>
                      {stats && isFocused && <SessionStats session={h} active={active}/>}
                    </div>
                  </>
                );
              })() : pluginPane && node.item ? (
                <>
                  {pluginPane.renderTitle({ leafId: node.id, item: node.item, multiPane, isFocused, controller })}
                  <div className="hs-pane-body">
                    {pluginPane.renderBody({ leafId: node.id, item: node.item, multiPane, isFocused, controller })}
                  </div>
                </>
              ) : emptyPaneOverride ? (
                emptyPaneOverride({ leafId: node.id, controller, defaultRender: defaultEmptyRender })
              ) : (
                defaultEmptyRender()
              )}
            </div>
          );
        };

        return (
          <>
            {layoutBarOverride?.({ leavesCount: leaves.length, controller, defaultRender: () => null })}
            {leaves.length === 1 && !leaves[0].item
              ? <div className="hs-placeholder"><p>Select a session, or start one.</p></div>
              : <div className="hs-layout-root">{renderNode(layout)}</div>}
            {bgOpened.map(id => <HiddenPaneSlot key={`bg:${id}`} sessionId={id} registerSlot={registerSlot}/>)}
            {opened.map(id => {
              if (!hosted.some(h => h.id === id)) return null;
              const el = slotEls[id];
              if (!el) return null;
              const isVisible = visibleSessions.has(id);
              return createPortal(<TerminalPane key={id} id={id} active={active && isVisible}/>, el, id);
            })}
          </>
        );
      })()}
    </main>
  </div>;
}
