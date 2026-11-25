import { basename as base, isAbsolutePath } from '../utils/paths';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BarChart3, BellRing, ChevronDown, ChevronRight, Copy, CornerDownRight, Eye, EyeOff, Folder, FolderOpen, FolderPlus, History, Link2, ListTree, MoreHorizontal, Network, Play, Plus, Radar, RotateCw, Search, SquareDashed, Terminal, Trash2, Unlink, X } from 'lucide-react';
import { Button, ConfirmDialog, Dialog, Menu, keepSame } from '@lambda-house/ui';
import { LayoutView, Pane, PaneMenu, PaneTitle, ShellTools, closeLeaf, findLeaf, leaves as leavesOf, splitLeaf, usePaneTypes, type Layout, type LayoutNode, type PaneContext, type PaneRef, type PaneType } from '@lambda-house/workbench';
import TerminalPane, { keep } from './TerminalPane';
import AgentMark from './AgentMark';
import SessionStats from './SessionStats';
import CockpitPanel from './CockpitPanel';
import { BackgroundGate } from './Background';
import { cacheClass, indexedSession, useSessionMetrics } from './SessionMetrics';
import { EarlierRow, HostedRow, hostedDetail, needsYou, ProgramLine } from './SessionRow';
import { agentProfileTitle, canRestart, directorySections, folderVisibility, HIDDEN_REASON, type HiddenReason, executorsBelow, HARNESS_PREFERENCES_CHANGED, harnessApi, hostedState, isSupervisor, liveSessionLabel, maybeOpenElsewhere, notAllowed, relationRows, runningFor, SESSION_DRAG_TYPE, sessionReference, sessionSummary, shellHealth, shortPath, STATE_LABEL, storeNoticeLines, subagentActive, subfolderTag, supervisorChoices, tildePath, type HarnessStatus, type RelationRow, type Hosted, type Resumable } from '../utils/harness';
import { useStore } from '../store';
import { EMPTY_HISTORY, renamed, step, visit } from '../utils/liveHistory';
import { liveNav } from '../utils/liveNav';
import { PLATFORM } from '../utils/platform';
import { CUSTOM_PANE, SESSION_PANE, addSlot, clearItems, findLeafByItem, isSlot, itemOf, newPaneId, paneOf, presetLayout, removeSessionFromLayout, replaceSessionInLayout, setLeafItem, slotsOf, type LayoutPreset, type PaneItem } from '../utils/paneLayout';
import { EMPTY_PANE, LIST_MIN_WIDTH, LIVE_LIST, useSessionsLayout } from '../sessionsLayout';
import { PanelChoices } from './PanesView';
import { pickDirectory, isTauri } from '../utils/tauri';
import { formatAge } from '../utils/agent';
import { pluginRegistry, usePluginVersion, type LiveControllerContext } from '../plugins';
import '../styles/harness.css';
import { formatSessionTitle, type Session } from '../utils/sessions';

const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const PINNED_KEY = 'hs-dirs';
const START: [string, string][] = [['claude', 'Claude Code'], ['codex', 'Codex']];
/** Folders with only history shown before "more" is asked for. */
const HISTORY_FOLDERS = 6;
const BACK_KEYS = PLATFORM === 'macos' ? '⌘[' : 'Alt+Left';
const FORWARD_KEYS = PLATFORM === 'macos' ? '⌘]' : 'Alt+Right';
const isAgent = (h: Hosted) => !h.exit && ['claude', 'codex'].includes(h.harness?.profile || h.meta.profile || '');
const EMPTY_TITLES: Record<string, string> = {};
const rowUsesClock = (h: Hosted, session?: Session) => {
  if (h.exit) return true;
  const t = h.harness;
  const hasAge = t?.state === 'working' || ((t?.state === 'idle' || t?.state === 'waiting') && (t.status?.trim() || t.lastMessage?.trim()));
  return !!(hasAge || h.waits?.length || h.shells?.length || h.subagents?.some(a => !a.finished) || session?.context?.cacheAt);
};

interface Action { label: string; icon: React.ReactNode; run: () => void; title?: string }

/** A button whose actions open as a menu: the "…" of a session row, the "+" of a folder. */
function RowMenu({ label, actions, icon, title = 'Actions', className = 'hs-actions', buttonClassName, disabled = false, wrapItems = false, tool }: { label: string; actions: Action[] | (() => Action[]); icon?: React.ReactNode; title?: string; className?: string; buttonClassName?: string; disabled?: boolean; wrapItems?: boolean;
  /** A pane header's tool: a ghost button with `icon` and this text after it (none: the icon alone) */
  tool?: { text?: string } }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Fixed position: the list scrolls and would clip a menu placed inside it
    const box = e.currentTarget.getBoundingClientRect();
    setAt(at ? null : { top: box.bottom + 2, right: Math.max(4, window.innerWidth - box.right) });
  };
  return <span className={className} ref={wrap}>
    {tool
      ? <Button variant="ghost" size="xs" icon={icon} aria-haspopup="menu" aria-expanded={!!at} aria-label={label} title={title} disabled={disabled} onClick={toggle}>{tool.text || undefined}</Button>
      : <button type="button" className={buttonClassName} aria-haspopup="menu" aria-expanded={!!at} aria-label={label} title={title} disabled={disabled} onClick={toggle}>{icon ?? <MoreHorizontal size={14}/>}</button>}
    {at && <Menu label={label} at={at} anchorRef={wrap} wrap={wrapItems} onClose={() => setAt(null)}
      items={(typeof actions === 'function' ? actions() : actions).map(a => ({ key: a.label, label: a.label, title: a.title, icon: a.icon, onSelect: () => {
        // The latest action of that name: a memoized row's menu still acts on the current Live state
        const current = typeof actions === 'function' ? actions().find(next => next.label === a.label) : a;
        current?.run();
      } }))}/>}
  </span>;
}

type RowHandlers = {
  select: (id: string) => void;
  reference: (h: Hosted) => string;
  actions: (h: Hosted) => Action[];
  connect: (id: string, supervisorId: string) => void;
  cancelBinding: () => void;
};

interface LiveSessionRowProps {
  h: Hosted;
  depth: number;
  executors: number;
  section: string;
  elsewhereCwd?: string;
  elsewhereLabel: string;
  home: string;
  label: string;
  selected: boolean;
  copied: boolean;
  peerNames: string;
  supervisorName: string;
  session?: Session;
  /** A shared clock tick invalidates only rows with time-dependent indicators. */
  clock: number;
  choices: { here: [string, string][]; elsewhere: [string, string][] } | null;
  handlers: RowHandlers;
}

/** Row props describe one session so a selection only changes the old and new rows. */
const LiveSessionRow = memo(function LiveSessionRow({
  h, depth, executors, section, elsewhereCwd, elsewhereLabel, home, label, selected, copied,
  peerNames, supervisorName, session, choices, handlers,
}: LiveSessionRowProps) {
  const now = Date.now();
  const choice = ([id, text]: [string, string]) => <option key={id} value={id}>{text}</option>;
  const sub = subfolderTag(section, h.cwd);
  const state = hostedState(h);
  const role = executors ? 'is-supervisor' : '';
  const works = h.harness?.supervisor ? 'is-executor' : '';
  const detail = hostedDetail(h, copied ? 'reference copied' : '');
  const subs = (h.subagents ?? []).filter(a => !a.finished);
  const shells = h.exit ? [] : h.shells ?? [];
  return <li key={h.id} style={depth ? { ['--level' as string]: Math.min(depth, 4) } : undefined} data-depth={depth || undefined}
    className={[selected ? 'selected' : '', needsYou(h) ? 'needs-you' : '', !needsYou(h) && (state === 'idle' || h.exit) && !shells.length ? 'idle' : '', cacheClass(h, session, now), role, works, depth ? 'hs-nested' : ''].filter(Boolean).join(' ')}>
    <button className="hs-item" onClick={() => handlers.select(h.id)}
      draggable={!h.exit} onDragStart={e => { e.dataTransfer.setData(SESSION_DRAG_TYPE, h.id); e.dataTransfer.setData('text/plain', handlers.reference(h)); e.dataTransfer.effectAllowed = 'copy'; }}
      title={`${STATE_LABEL[state]} · pid ${h.pid ?? '?'}\n${h.argv.join(' ')}\n${h.cwd}${h.peers?.length ? `\nIn contact with: ${peerNames}` : ''}${h.exit ? '' : '\nDrag into a terminal to point its agent at this session'}`}>
      <HostedRow hosted={h} label={label} session={session} detail={detail}
        before={works && <span className="hs-rel executor" title={`Executor of ${supervisorName}${depth > 4 ? ` · level ${depth}` : ''}`} aria-label="Executor"><CornerDownRight size={11}/>{depth > 4 ? depth : ''}</span>}
        after={executors > 0 && <span className="hs-rel supervisor" title={`Supervises ${executors} executor${executors > 1 ? 's' : ''}`} aria-label={`Supervisor of ${executors}`}><Network size={11}/>{executors}</span>}
        // Its folder below the section's on a line of its own: in the name it would be the first thing the ellipsis cuts (MCR-133)
      under={elsewhereCwd !== undefined ? <small className="hs-under" title={elsewhereCwd}>under {elsewhereLabel} · {shortPath(tildePath(elsewhereCwd, home))}</small>
          : sub && <small className="hs-under"><span className="hs-rel subdir" title={`Works in ${sub.path}`}>{sub.tag}</span></small>}/>
    </button>
    <RowMenu label={`Actions for ${label}`} actions={() => handlers.actions(h)}/>
    {choices !== null && <form className="hs-bind" aria-label={`Connect ${label} to a supervisor`} onSubmit={e => e.preventDefault()}>
      <select aria-label="Supervisor" autoFocus defaultValue="" onChange={e => { if (e.target.value) handlers.connect(h.id, e.target.value); }}>
        <option value="" disabled>{choices.here.length + choices.elsewhere.length ? 'Works for…' : 'No other agent session is running'}</option>
        {/* Two groups stand in for a separator, which a native select does not draw in every WebKit; one group alone needs no heading */}
        {choices.here.length > 0 && choices.elsewhere.length > 0
          ? <><optgroup label="This folder">{choices.here.map(choice)}</optgroup><optgroup label="Other folders">{choices.elsewhere.map(choice)}</optgroup></>
          : [...choices.here.map(choice), ...choices.elsewhere.map(choice)]}
      </select>
      <Button variant="secondary" size="xs" onClick={() => handlers.cancelBinding()}>Cancel</Button>
    </form>}
    {shells.length > 0 && <ul className="hs-subs hs-shells" aria-label={`Running shells of ${label}`}>
      {shells.map(sh => {
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
        const live = subagentActive(a, now);
        return <li key={a.id} className={live ? 'active' : ''} title={[a.agentType, a.model, live ? 'active' : `quiet, last activity ${formatAge(a.lastActivity)}`, `started ${formatAge(a.started)}`].filter(Boolean).join(' · ')}>
          <span className={`hs-dot ${live ? 'working' : ''}`} aria-label={live ? 'active' : 'quiet'}/>
          <span className="hs-item-text"><strong>{a.description || `Subagent ${a.id.slice(0, 8)}`}</strong></span>
        </li>;
      })}
    </ul>}
  </li>;
});

/**
 * Whether a pane body is on screen with some size: only then does its terminal attach (MCR-140).
 * The Cockpit can push the Supervisor's terminal offscreen or squeeze it to zero height while
 * its pane stays shown. While the window is hidden the last answer stands (background WebKit
 * can report an empty viewport); it is asked again when the window comes back.
 */
function useOnScreen(ref: React.RefObject<HTMLElement | null>, watching: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !watching) { setShown(false); return; }
    let observing = true;
    let live = true;
    const intersection = new IntersectionObserver(entries => {
      if (!live || document.hidden || !observing) return;
      const entry = entries[entries.length - 1];
      setShown(!!entry?.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
    }, { threshold: [0, Number.EPSILON] });
    const resize = new ResizeObserver(([entry]) => {
      if (!live || document.hidden || !entry) return;
      const { width, height } = entry.contentRect;
      const sized = width > 0 && height > 0;
      if (sized === observing) return;
      observing = sized;
      if (sized) intersection.observe(el);
      else {
        intersection.unobserve(el);
        setShown(false);
      }
    });
    const stop = () => {
      resize.disconnect();
      intersection.disconnect();
      intersection.takeRecords();
    };
    const watch = () => {
      stop();
      if (document.hidden) return;
      observing = true;
      intersection.observe(el);
      resize.observe(el);
    };
    document.addEventListener('visibilitychange', watch);
    watch();
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', watch);
      stop();
      setShown(false);
    };
  }, [ref, watching]);
  return shown;
}

/** A session pane's body: the terminal attaches only while the body is on screen with some size. */
function PaneBody({ watching, terminal, children }: { watching: boolean; terminal: () => React.ReactNode; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(ref, watching);
  return <div className="hs-pane-body" ref={ref}>
    {watching && onScreen && terminal()}
    {children}
  </div>;
}

/** Smallest pane in Live, px. */
const PANE_MIN = { w: 240, h: 120 };

/** A pane Live draws: its leaf and what it shows (nothing yet: the empty pane). */
interface LivePane { id: string; item: PaneItem | null }

/**
 * Agent terminals hosted by the runner. They keep running when this view, the
 * Sessions workspace or the whole app closes (docs/AGENT_HARNESS_DESIGN.md, D1).
 */
export default function LiveWorkspace({ active, recentDirectories, titles: indexTitles = EMPTY_TITLES, sessionAccess = false, onSearch, focus }: {
  active: boolean; recentDirectories: string[];
  sessionAccess?: boolean;
  /** A session to show, asked for from another view; `at` makes a repeated ask count */
  focus?: { id: string; at: number };
  /** Display titles by conversation id, when the Sessions index has them */
  titles?: Record<string, string>;
  /** Open the search view narrowed to a folder */
  onSearch?: (directory: string) => void;
}) {
  const sessionLabel = (h: Hosted) => liveSessionLabel(h, titles);
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  // The background processes are not allowed: never asked ('new'), or stopped by the person
  const [gate, setGate] = useState<'new' | 'stopped' | null>(null);
  const [hosted, setHosted] = useState<Hosted[]>([]);
  const metrics = useSessionMetrics(active, hosted, sessionAccess);
  // The hosted conversations' titles come with their figures, every ten seconds; the index's (for earlier
  // sessions) with the Sessions workspace's snapshot, which it reads seldom while Live is shown (MCR-139)
  const titles = useMemo(() => ({ ...indexTitles, ...Object.fromEntries(Object.values(metrics).filter(s => !s.parentId).map(s => [s.id, formatSessionTitle(s)])) }), [indexTitles, metrics]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [opened, setOpened] = useState<string[]>([]);
  // Live's layout (the list, the panes sessions open in, any panel) and the pane a session opens in, kept per viewer
  const layout = useSessionsLayout(s => s.layouts.live);
  const focusedPane = useSessionsLayout(s => s.focused.live);
  const setLayout = useCallback((change: (root: LayoutNode) => LayoutNode) => {
    const { layouts, setLayout: set } = useSessionsLayout.getState();
    set('live', change(layouts.live));
  }, []);
  const setFocusedPane = useCallback((leafId: string) => useSessionsLayout.getState().focus('live', leafId), []);
  const leaves = useMemo(() => leavesOf(layout), [layout]);
  // The panes a session can open in: sessions', plugins' and empty ones
  const slots = useMemo(() => leaves.filter(isSlot), [leaves]);
  const assignedSessions = useMemo(() => new Set(leaves.flatMap(({ pane }) => { const item = itemOf(pane); return item?.kind === 'session' && item.id ? [item.id] : []; })), [leaves]);
  useLayoutEffect(() => { keep.protect(assignedSessions); }, [assignedSessions]);
  useLayoutEffect(() => () => keep.protect(new Set()), []);
  const focusedItem = itemOf(leaves.find(leaf => leaf.id === focusedPane)?.pane);
  const [profile, setProfile] = useState('claude');
  const [cwd, setCwd] = useState('');
  const [starting, setStarting] = useState(false);
  const [pastSessions, setResumable] = useState<Resumable[]>([]);
  const resumable = useMemo(() => pastSessions.filter(r => status?.profiles.some(p => p.id === r.agent)), [pastSessions, status]);
  const [resume, setResume] = useState('');
  const [copied, setCopied] = useState(false);
  const [referenced, setReferenced] = useState('');
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState('');
  const [pinned, setPinned] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(PINNED_KEY) || '[]') as string[]; } catch { return []; } });
  const pin = (next: string[]) => { setPinned(next); try { localStorage.setItem(PINNED_KEY, JSON.stringify(next)); } catch { /* not kept */ } };
  const [allHistory, setAllHistory] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(() => new Set<string>());
  // What the person chose to see of the list (MCR-107): kept in the app's settings
  const liveList = useStore(s => s.liveList);
  const setLiveList = useStore(s => s.setLiveList);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  // "Remove ended sessions": the ones counted when the question was asked
  const [removing, setRemoving] = useState<string[] | null>(null);
  // The session being connected to a supervisor: its row shows the chooser
  const [binding, setBinding] = useState('');
  // The usage pane beside the terminal: open or closed is this viewer's preference
  const [stats, setStats] = useState(() => { try { return localStorage.getItem('hs-stats') === '1'; } catch { return false; } });
  const toggleStats = () => setStats(on => { try { localStorage.setItem('hs-stats', on ? '0' : '1'); } catch { /* not kept */ } return !on; });
  // Sessions the person closed: once they have ended they leave the list too
  const closing = useRef(new Set<string>());
  // The service's list has been read since this view mounted: before that an empty list says nothing
  const listRead = useRef(false);
  const [listed, setListed] = useState(false);
  const listStamp = useRef('');
  const listRequest = useRef(0);
  const listShown = useRef(0);
  const mounted = useRef(true);

  // Nothing runs and nothing may be started: the list gives way to the question
  const closed = useCallback(() => {
    listStamp.current = '';
    listShown.current = ++listRequest.current;
    setStatus(null); setHosted([]); setOpened([]); setSelected(''); setError('');
    harnessApi.background().then(b => { if (mounted.current) setGate(b.consent === 'stopped' ? 'stopped' : 'new'); }).catch(() => { if (mounted.current) setGate('new'); });
  }, []);
  const connect = useCallback(() => {
    harnessApi.status().then(s => {
      if (!Array.isArray(s.profiles)) throw new Error('An older harness service returned no launch profiles. Update the app and restart the harness service.');
      if (mounted.current) {
        // A focus asks again; the same answer keeps the held one, so nothing below starts over (MCR-139)
        setStatus(held => keepSame(held, s));
        setGate(null);
        setError('');
        setCwd(c => c || s.home);
        setProfile(p => s.profiles.some(next => next.id === p) ? p : s.profiles[0]?.id ?? '');
      }
    }).catch(e => { if (!mounted.current) return; if (notAllowed(e)) closed(); else setError(err(e)); });
  }, [closed]);
  const refresh = useCallback(async function refreshList() {
    const request = ++listRequest.current;
    const stamp = listStamp.current;
    try {
      const answer = await harnessApi.listSince(stamp);
      if (!mounted.current || request <= listShown.current) return;
      listShown.current = request;
      // An overlapping read replaced the base for this unchanged reply.
      if (!answer.sessions && stamp !== listStamp.current) return refreshList();
      listRead.current = true;
      setListed(true);
      if (answer.sessions) {
        listStamp.current = answer.stamp;
        const next = answer.sessions;
        setHosted(held => {
          const byId = new Map(held.map(h => [h.id, h]));
          const rows = next.map(h => keepSame(byId.get(h.id), h) ?? h);
          return rows.length === held.length && rows.every((h, i) => h === held[i]) ? held : rows;
        });
      }
      setError('');
    } catch (e) {
      if (!mounted.current || request <= listShown.current) return;
      listShown.current = request;
      if (notAllowed(e)) closed(); else setError(err(e));
    }
  }, [closed]);

  useEffect(() => {
    mounted.current = true;
    if (!isTauri()) { setError('Open the desktop app to host agent terminals.'); return; }
    connect();
    window.addEventListener(HARNESS_PREFERENCES_CHANGED, connect);
    window.addEventListener('focus', connect);
    return () => { mounted.current = false; window.removeEventListener(HARNESS_PREFERENCES_CHANGED, connect); window.removeEventListener('focus', connect); };
  }, [connect]);
  useEffect(() => {
    if (!active || !status) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [active, status, refresh]);

  // Earlier sessions to resume; without the Sessions grant there are none to offer
  const loadResumable = useCallback(() => {
    harnessApi.resumable()
      .then(r => { if (mounted.current) setResumable(held => keepSame(held, r)); })
      .catch(() => {});
  }, []);
  useEffect(() => { if (active && status) loadResumable(); }, [active, status, newAgentOpen, loadResumable]);
  // Back in the window: the list and the earlier sessions are read again at once, and render only if they changed
  useEffect(() => {
    if (!active || !status) return;
    const again = () => { void refresh(); loadResumable(); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [active, status, refresh, loadResumable]);

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
      // The pane chosen last, while it can still take a session (not the list, not a panel)
      const chosen = findLeaf(prev, focusedPane);
      const focused = chosen && isSlot(chosen) ? chosen : undefined;
      if (existing && existing.id !== focused?.id) {
        if (focused && !itemOf(focused.pane)) {
          return setLeafItem(setLeafItem(prev, existing.id, null), focused.id, item);
        }
        setFocusedPane(existing.id);
        return prev;
      }
      if (focused) return setLeafItem(prev, focused.id, item);
      // None chosen: the first pane that can take it, or a new one beside the list
      const first = slotsOf(prev)[0];
      const target = first?.id ?? newPaneId('p');
      setFocusedPane(target);
      return first ? setLeafItem(prev, target, item) : addSlot(prev, target, item);
    });
  }, [focusedPane, setLayout, setFocusedPane]);

  const clearItemFromLayout = useCallback((predicate: (item: PaneItem) => boolean) => {
    setLayout(prev => clearItems(prev, predicate));
  }, [setLayout]);

  const select = (id: string) => {
    openItem({ kind: 'session', id });
  };
  // Back and Forward (MCR-108): every change of the shown session is a place in the history, whatever made it
  const [history, setHistory] = useState(EMPTY_HISTORY);
  // The session Back or Forward is going to: that change is a step, not a new place
  const stepping = useRef('');
  useEffect(() => {
    if (!selected) return;
    if (stepping.current === selected) { stepping.current = ''; return; }
    setHistory(h => visit(h, selected));
  }, [selected]);
  const running = (id: string) => hosted.some(h => h.id === id && !h.exit);
  const backTo = step(history, -1, running);
  const forwardTo = step(history, 1, running);
  /** Show the session at that place: as a row click does. Nothing is typed, and its terminal does not take the keyboard */
  const goTo = (index: number | null) => {
    if (index === null) return;
    const id = history.entries[index];
    setHistory(h => ({ ...h, index }));
    stepping.current = id;
    select(id);
  };
  const goBack = () => goTo(step(history, -1, running));
  const goForward = () => goTo(step(history, 1, running));
  // The app's Back and Forward commands come here while the Live view is shown
  const nav = useRef({ goBack, goForward, backTo, forwardTo });
  nav.current = { goBack, goForward, backTo, forwardTo };
  useEffect(() => {
    if (!active) return;
    const mine = { canBack: () => nav.current.backTo !== null, canForward: () => nav.current.forwardTo !== null, back: () => nav.current.goBack(), forward: () => nav.current.goForward() };
    liveNav.current = mine;
    return () => { if (liveNav.current === mine) liveNav.current = null; };
  }, [active]);
  // A click on `mcr:<id>` in a terminal: that session is selected like its row, and its terminal takes the keyboard.
  // The request is dropped once its pane served it, or a pane mounted again later would take the keyboard with no click
  const [linked, setLinked] = useState<{ id: string; at: number } | null>(null);
  // The same function while the same sessions run: a terminal looks at its links again when it changes (MCR-106)
  const liveIds = hosted.filter(h => !h.exit).map(h => h.id).join(' ');
  const isSession = useCallback((id: string) => liveIds.split(' ').includes(id), [liveIds]);
  // A kept terminal goes with its session from the list (an ended session in the list keeps its own)
  const listedIds = hosted.map(h => h.id).join(' ');
  useEffect(() => { if (listRead.current) keep.retain(new Set(listedIds.split(' ').filter(Boolean))); }, [listedIds]);
  const follow = (id: string) => { if (!isSession(id)) return; select(id); setLinked({ id, at: Date.now() }); };
  const acknowledging = useRef(new Map<string, number>());
  useEffect(() => {
    const acknowledge = () => {
      if (!active || document.hidden || !document.hasFocus()) return;
      const attention = hosted.find(h => h.id === selected)?.harness?.attention;
      if (attention?.kind !== 'notification' || acknowledging.current.get(selected) === attention.since) return;
      acknowledging.current.set(selected, attention.since);
      void harnessApi.ack(selected, attention.since).then(refresh).catch(e => setError(err(e))).finally(() => acknowledging.current.delete(selected));
    };
    acknowledge();
    window.addEventListener('focus', acknowledge);
    document.addEventListener('visibilitychange', acknowledge);
    return () => { window.removeEventListener('focus', acknowledge); document.removeEventListener('visibilitychange', acknowledge); };
  }, [active, hosted, selected, refresh]);
  /** A pane was pointed at: one a session can open in becomes the chosen one, and its session the selected. */
  const focusPane = (leafId: string) => {
    const leaf = findLeaf(useSessionsLayout.getState().layouts.live, leafId);
    if (!leaf || !isSlot(leaf)) return;
    setFocusedPane(leafId);
    const item = itemOf(leaf.pane);
    if (item?.kind === 'session' && item.id) {
      setSelected(item.id);
      pluginRegistry.emitEvent('session:selected', { id: item.id });
    }
  };
  const splitPane = useCallback((leafId: string, dir: 'row' | 'col') => {
    const id = newPaneId('p');
    setLayout(prev => splitLeaf(prev, leafId, dir, 'after', { kind: 'leaf', id, pane: paneOf(null) }, newPaneId('s')));
    setFocusedPane(id);
    pluginRegistry.emitEvent('pane:split', { leafId, dir });
  }, [setLayout, setFocusedPane]);
  const closePane = useCallback((leafId: string) => {
    setLayout(prev => closeLeaf(prev, leafId));
    pluginRegistry.emitEvent('pane:closed', { leafId });
  }, [setLayout]);
  // The chosen pane went (closed, joined, or it shows the list or a panel now): the first one a session can open in
  useEffect(() => {
    const chosen = findLeaf(layout, focusedPane);
    if (chosen && isSlot(chosen)) return;
    const next = slots[0];
    if (!next) return;
    setFocusedPane(next.id);
    const item = itemOf(next.pane);
    setSelected(item?.kind === 'session' && item.id ? item.id : '');
  }, [layout, focusedPane, slots, setFocusedPane]);
  const applyPreset = useCallback((preset: LayoutPreset) => {
    const pool: PaneItem[] = slotsOf(layout).flatMap(l => { const item = itemOf(l.pane); return item ? [item] : []; });
    for (const id of opened) {
      if (!pool.some(x => x.kind === 'session' && x.id === id)) pool.push({ kind: 'session', id });
    }
    const next = presetLayout(layout, preset, pool);
    setLayout(() => next.root);
    setFocusedPane(next.focused);
    const firstItem = itemOf(findLeaf(next.root, next.focused)?.pane);
    if (firstItem?.kind === 'session' && firstItem.id) setSelected(firstItem.id);
  }, [layout, opened, setLayout, setFocusedPane]);

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
  // Live's layout, drawn by the workbench's LayoutView: its handles and pane menus change it in the store
  const drawn = useMemo<Layout>(() => ({ version: 1, root: layout }), [layout]);
  const applyDrawn = useCallback((next: Layout) => {
    const before = useSessionsLayout.getState().layouts.live;
    useSessionsLayout.getState().setLayout('live', next.root);
    for (const leaf of leavesOf(before)) if (!findLeaf(next.root, leaf.id)) pluginRegistry.emitEvent('pane:closed', { leafId: leaf.id });
  }, []);
  const resetLayout = useCallback(() => useSessionsLayout.getState().reset('live'), []);
  // The panes kept from the last run: a session still listed opens in its pane again (its terminal attaches
  // while the pane is shown), one that is gone leaves its pane empty. Once, at the first read of the list
  const restored = useRef(false);
  useEffect(() => {
    if (!listed || restored.current) return;
    restored.current = true;
    const known = new Set(hosted.map(h => h.id));
    setLayout(prev => clearItems(prev, item => item.kind === 'session' && !known.has(item.id)));
    const kept = [...assignedSessions].filter(id => known.has(id));
    if (kept.length) setOpened(o => [...new Set([...o, ...kept])]);
    if (focusedItem?.kind === 'session' && known.has(focusedItem.id)) setSelected(focusedItem.id);
  }, [listed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (focus?.id) select(focus.id); }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = useMemo(() => hosted.filter(h => !h.exit && h.harness?.attention), [hosted]);
  const suggestions = useMemo(() => [...new Set([status?.home ?? '', ...recentDirectories].filter(Boolean))].slice(0, 40), [status, recentDirectories]);
  // Rows keep their place: running ones in the order they were started, ended ones after them.
  // One that needs the person is marked, not moved. The supervisor has its own tile above the list
  const sorted = useMemo(() => hosted.filter(h => h.exit || !isSupervisor(h)).sort((a, b) => Number(!!a.exit) - Number(!!b.exit) || a.started - b.started || a.id.localeCompare(b.id)), [hosted]);

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
    navigator.clipboard.writeText(sessionReference(h, titles)).then(() => { setReferenced(h.id); setTimeout(() => setReferenced(r => r === h.id ? '' : r), 1500); }).catch(e => setError(err(e)));
  };
  /** The agent is ended and continues its conversation in a new process, with today's settings and tools. */
  const restart = (h: Hosted) => {
    setError('');
    harnessApi.restart(h.id).then(async fresh => {
      await refresh();
      // The new id takes the old one's place among the opened too: a pane that shows it without being the selected one needs its terminal
      setOpened(o => o.map(x => x === h.id ? fresh.id : x));
      setLayout(l => replaceSessionInLayout(l, h.id, fresh.id));
      setHistory(hist => renamed(hist, h.id, fresh.id));
      if (selected === h.id) select(fresh.id);
      if (!fresh.resumed) setError(`${sessionLabel(h)} had no saved conversation to continue: it started fresh in the same folder.`);
    }).catch(e => { setError(err(e)); void refresh(); });
  };
  /** A new session that works for `h`, in its folder */
  const startExecutor = async (h: Hosted, profile: string) => {
    setStarting(true); setError('');
    try { const x = await harnessApi.spawn(profile, h.cwd, 120, 32, undefined, h.id); await refresh(); select(x.id); loadResumable(); }
    catch (e) { setError(err(e)); }
    finally { setStarting(false); }
  };
  const connect_to = (id: string, supervisorId: string | null) => { setBinding(''); act(async () => { await harnessApi.bind(id, supervisorId); }); };
  const actions = (h: Hosted): Action[] => [
    // Any agent session can have executors; the Supervisor sees everything already
    ...(isAgent(h) && !isSupervisor(h) ? START.map(([profile, what]) => ({ label: `New executor (${what}) · Preview`, icon: <CornerDownRight size={13}/>, run: () => void startExecutor(h, profile) })) : []),
    ...(!h.exit && !isSupervisor(h) && !h.harness?.supervisor ? [{ label: 'Connect to supervisor…', icon: <Link2 size={13}/>, run: () => setBinding(h.id) }] : []),
    ...(!h.exit && h.harness?.supervisor ? [{ label: 'Detach from supervisor', icon: <Unlink size={13}/>, run: () => connect_to(h.id, null) }] : []),
    { label: 'Copy reference', icon: <Copy size={13}/>, run: () => copyReference(h) },
    ...(canRestart(h) ? [{ label: 'Restart (reload settings)', icon: <RotateCw size={13}/>, run: () => restart(h) }] : []),
    { label: h.exit ? 'Remove from the list' : 'Close session', icon: <X size={13}/>, run: () => close(h) },
  ];
  const names = new Map(hosted.map(h => [h.id, sessionLabel(h)]));
  const addFolder = (raw: string) => {
    const input = raw.trim();
    const path = /^[A-Za-z]:[\\/]$/.test(input) ? input : input.replace(/[\\/]+$/, '') || '/';
    if (!path) return;
    if (!pinned.includes(path)) pin([...pinned, path]);
    setCwd('');
  };
  const home = status?.home ?? '';
  const allSections = useMemo(() => directorySections(sorted, resumable.filter(r => !/[\\/]agent-mcr[\\/]supervisor$/.test(r.cwd)), pinned), [sorted, resumable, pinned]);
  // Hidden folders and past sessions leave the list before anything is counted (MCR-107)
  const { shown: sections, hidden: hiddenFolders } = useMemo(() => folderVisibility(allSections, liveList), [allSections, liveList]);
  const recentHistory = sections.filter(d => !d.sessions.length && !d.pinned).sort((a, b) => b.latest - a.latest).slice(0, HISTORY_FOLDERS);
  const shown = allHistory ? sections : sections.filter(d => d.sessions.length || d.pinned || recentHistory.includes(d));
  const hideFolder = (path: string) => setLiveList(p => ({ ...p, hiddenFolders: [...p.hiddenFolders.filter(x => x !== path), path], shownFolders: p.shownFolders.filter(x => x !== path) }));
  // Shown again by the person: also over the automatic rule, or a folder that is gone or temporary would stay out with that reason
  const showFolder = (path: string, reason: HiddenReason, earlier: string[]) => setLiveList(p => reason === 'hidden' ? { ...p, hiddenFolders: p.hiddenFolders.filter(x => x !== path), shownFolders: [...p.shownFolders.filter(x => x !== path), path] }
    : reason === 'sessions hidden' ? { ...p, hiddenSessions: p.hiddenSessions.filter(id => !earlier.includes(id)) }
    : { ...p, shownFolders: [...p.shownFolders.filter(x => x !== path), path] });
  /** All past sessions of a folder, hidden ones too: what "show them" brings back */
  const sessionsOf = (path: string) => allSections.find(x => x.path === path)?.earlier.map(r => r.id) ?? [];
  const hideSession = (id: string) => setLiveList(p => ({ ...p, hiddenSessions: [...p.hiddenSessions.filter(x => x !== id), id] }));
  // A hidden past session that left the history (resumed, or older than it reaches) needs no place in the
  // settings. Folders are never dropped: whether a folder is still in the list depends on more than the
  // history (the status, a profile turned off), and a lost choice costs more than a few kept bytes
  useEffect(() => {
    if (!pastSessions.length || !liveList.hiddenSessions.length) return;
    const known = new Set(pastSessions.map(r => r.id));
    if (liveList.hiddenSessions.some(id => !known.has(id))) setLiveList(p => ({ ...p, hiddenSessions: p.hiddenSessions.filter(id => known.has(id)) }));
  }, [pastSessions, liveList.hiddenSessions, setLiveList]);
  const ended = hosted.filter(h => h.exit);
  /** Every ended session the question counted leaves the list; a session's conversation stays on disk. */
  const removeEnded = (ids: string[]) => act(async () => {
    // Each on its own: one that fails leaves the others removed, and is said
    const results = await Promise.allSettled(ids.map(id => harnessApi.forget(id)));
    const done = ids.filter((_, i) => results[i].status === 'fulfilled');
    setOpened(o => o.filter(x => !done.includes(x)));
    setLayout(l => done.reduce((layout, id) => removeSessionFromLayout(layout, id), l));
    setSelected(s => done.includes(s) ? '' : s);
    done.forEach(id => pluginRegistry.emitEvent('session:closed', { id }));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw new Error(`${ids.length - done.length} of ${ids.length} ended sessions could not be removed: ${err(failed.reason)}`);
  });

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
  const supervisorSummary = supervisor ? sessionSummary(supervisor, Date.now()) : null;
  const latestRowHandlers = useRef<RowHandlers | null>(null);
  useLayoutEffect(() => {
    latestRowHandlers.current = {
      select,
      reference: h => sessionReference(h, titles),
      actions,
      connect: connect_to,
      cancelBinding: () => setBinding(''),
    };
  });
  // The row can skip a render while a menu action still sees the latest Live state.
  const rowHandlers = useMemo<RowHandlers>(() => ({
    select: id => latestRowHandlers.current!.select(id),
    reference: h => latestRowHandlers.current!.reference(h),
    actions: h => latestRowHandlers.current?.actions(h) ?? [],
    connect: (id, supervisorId) => latestRowHandlers.current!.connect(id, supervisorId),
    cancelBinding: () => latestRowHandlers.current!.cancelBinding(),
  }), []);
  const bindingChoices = useMemo(() => {
    const h = binding && hosted.find(row => row.id === binding);
    if (!h) return null;
    const below = executorsBelow(h.id, hosted);
    const candidates = hosted.filter(x => isAgent(x) && !isSupervisor(x) && x.id !== h.id && !below.has(x.id));
    const choices = supervisorChoices(h, candidates);
    return {
      here: choices.here.map((x): [string, string] => [x.id, liveSessionLabel(x, titles)]),
      elsewhere: choices.elsewhere.map((x): [string, string] => [
        x.id, `${liveSessionLabel(x, titles)} · ${shortPath(tildePath(x.cwd, home))}`,
      ]),
    };
  }, [binding, hosted, titles, home]);
  const [rowClock, setRowClock] = useState(0);
  const hasTimedRows = resumable.length > 0 || hosted.some(h => rowUsesClock(h, indexedSession(h, metrics)));
  useEffect(() => {
    if (!active || !hasTimedRows) return;
    const tick = () => { if (!document.hidden) setRowClock(Date.now()); };
    tick();
    const timer = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [active, hasTimedRows]);

  /** The section supplies the relative folder for an executor listed below its supervisor. */
  const row = ({ session: h, depth, executors, elsewhere }: RelationRow, section = h.cwd) => {
    const session = indexedSession(h, metrics);
    return <LiveSessionRow key={h.id} h={h} depth={depth} executors={executors} section={section}
      elsewhereCwd={elsewhere?.cwd} elsewhereLabel={elsewhere ? sessionLabel(elsewhere) : ''} home={home}
      label={sessionLabel(h)} selected={h.id === selected} copied={h.id === referenced}
      peerNames={h.peers?.map(id => names.get(id) ?? id).join(', ') ?? ''}
      supervisorName={names.get(h.harness?.supervisor ?? '') ?? 'a session'}
      session={session} clock={rowUsesClock(h, session) ? rowClock : 0}
      choices={binding === h.id ? bindingChoices : null} handlers={rowHandlers}/>;
  };

  const sidebarOverride = pluginRegistry.getOverride('live:sidebar');
  const newAgentOverride = pluginRegistry.getOverride('live:new-agent');
  const layoutBarOverride = pluginRegistry.getOverride('live:layout-bar');
  const paneTools = pluginRegistry.getOverride('live:pane-tools');
  const sessionHeaderOverride = pluginRegistry.getOverride('live:session-header');

  const closeNewAgent = () => { setNewAgentOpen(false); setProjectFilter(''); setResume(''); };
  const defaultNewAgent = () => (
    <Dialog open={newAgentOpen} onClose={closeNewAgent} title="New agent" size="lg" footerLayout="spread" footer={<>
      <Button variant="ghost" size="sm" onClick={closeNewAgent}>Cancel</Button>
      <Button variant="primary" size="sm" icon={<Play size={12}/>} disabled={!status || (!selectedResume && !status.profiles.some(p => p.id === profile)) || (!cwd && !selectedResume) || starting} onClick={() => void start(profile, cwd, selectedResume?.id ?? '')}>
        {starting ? 'Starting…' : selectedResume ? `Resume ${selectedResume.agent === 'claude' ? 'Claude' : 'Codex'}` : `Start ${(status?.profiles ?? []).find(p => p.id === profile)?.label ?? profile}`}
      </Button>
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
              else if (isAbsolutePath(q)) selectProjectCwd(q);
            }
          }} placeholder="Filter projects or paste a folder path…" aria-label="Filter projects"/>
          <Button variant="secondary" size="sm" icon={<FolderOpen size={13}/>} onClick={async () => { try { const dir = await pickDirectory(); if (dir) { selectProjectCwd(dir); setProjectFilter(''); } } catch (e) { setError(err(e)); } }}>Browse…</Button>
        </div>
        <div className="hs-split-picker">
          <div className="hs-split-col">
            <div className="hs-modal-label">Projects</div>
            <div className="hs-folder-list">
              {isAbsolutePath(projectFilter.trim()) && !suggestions.includes(projectFilter.trim()) && (
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
            {status?.profiles.length === 0 && <p>Enable a harness in Settings → Harnesses.</p>}
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
    <Pane as="aside" className="hs-list" aria-label="Hosted sessions" title="Sessions" tools={<>
      <Button variant="ghost" size="xs" icon={<FolderPlus size={14}/>} aria-label="Add project" title="Add a project: choose a folder to work in" onClick={async () => { try { const dir = await pickDirectory(); if (dir) addFolder(dir); } catch (e) { setError(err(e)); } }}/>
      <RowMenu className="hs-notifications-wrap" tool={{ text: waiting.length ? String(waiting.length) : '' }} wrapItems label="Notifications" title="Notifications from sessions" disabled={!waiting.length}
        icon={<BellRing size={14}/>} actions={waiting.map(h => ({ label: `${sessionLabel(h)}: ${h.harness!.attention!.text}`, icon: <BellRing size={14}/>, run: () => select(h.id) }))}/>
    </>}>
      <div className="hs-list-body">
      {error && <div className="hs-error" role="alert">{error}</div>}
      {status?.storeNotice && (() => {
        const notice = status.storeNotice;
        const lines = storeNoticeLines(notice);
        return (
          <div className="hs-error hs-store-notice" role="alert">
            <p>{lines.what}</p>
            <p>{lines.kept}</p>
            {!notice.frozen && <Button variant="ghost" size="xs" onClick={() => { void harnessApi.storeNoticeSeen().then(left => { if (mounted.current) setStatus(s => s && { ...s, storeNotice: left }); }).catch(e => setError(String(e))); }}>Dismiss</Button>}
          </div>
        );
      })()}
      {pluginRegistry.getSidebarSections().map(section => (
        <div key={section.id} className="hs-plugin-sidebar-section">
          {section.render(controller)}
        </div>
      ))}
      <div className={`hs-supervisor${supervisor ? ' running' : ''}${supervisor && supervisor.id === selected ? ' selected' : ''}${supervisor && needsYou(supervisor) ? ' needs-you' : ''}`}>
        <button type="button" className="hs-supervisor-open" disabled={!status || starting || (!supervisor && status.supervisorProfile === null)} onClick={() => void openSupervisor()}
          title={`Supervisor harness: ${supervisor?.meta.profile ?? status?.supervisorProfile ?? 'none'}. It sees and directs the other sessions. Only you can answer their permission prompts. Choose its harness in Settings → Harnesses.`}>
          <Radar size={15}/>
          <span className="hs-item-text">
            <strong>{supervisor ? 'Supervisor' : 'Open supervisor'}{supervisor && <span className={`hs-dot ${hostedState(supervisor)}`} aria-label={STATE_LABEL[hostedState(supervisor)]}/>}</strong>
            {supervisor && referenced === supervisor.id && <small>reference copied</small>}
            {supervisor && needsYou(supervisor) && <small className="hs-needs">{supervisor.harness?.attention?.text}</small>}
            {supervisorSummary && <small className="hs-status" title={supervisorSummary.full || undefined}>{supervisorSummary.lead && <span className="hs-lead">{supervisorSummary.lead}</span>}{supervisorSummary.text && <span>{supervisorSummary.text}</span>}</small>}
          </span>
        </button>
        {supervisor && <RowMenu label="Actions for the supervisor" actions={actions(supervisor)}/>}
      </div>
      {gate && <BackgroundGate stopped={gate === 'stopped'} onAllowed={connect}/>}
      <ul className="hs-dirs">
        {shown.map(d => {
          const name = tildePath(d.path, home);
          const open = earlierOpen.has(d.path);
          return <li key={d.path} className={`hs-dir${d.sessions.some(h => !h.exit) ? ' live' : ''}`} aria-label={`Folder ${d.path}`}>
            <header className="hs-dir-head">
              <span className="hs-dir-path" title={d.path}>{shortPath(name)}</span>
              <span className="hs-dir-rule"/>
              <RowMenu className="hs-dir-tools" label={`Start a session in ${d.path}`} title={`Start a session in ${name}`} icon={<Plus size={13}/>} disabled={!status?.profiles.length || starting}
                actions={[
                  ...(status?.profiles ?? []).map(p => ({ label: p.id === 'shell' ? 'Terminal' : p.label, icon: <AgentMark profile={p.id} size={13}/>, run: () => void start(p.id, d.path) })),
                  // Agent profiles (MCR-126 P2): the id goes to the service, which starts the session from it
                  ...(status?.agentProfiles ?? []).map(p => ({ label: p.id, title: agentProfileTitle(p), icon: <AgentMark profile={p.adapter} size={13}/>, run: () => void start(p.id, d.path) })),
                ]}/>
              {onSearch && <button type="button" className="hs-dir-start" title={`Search the history of ${name}`} aria-label={`Search the history of ${d.path}`} onClick={() => onSearch(d.path)}><Search size={12}/></button>}
              {d.pinned && !d.sessions.length && <button type="button" className="hs-dir-start" title="Remove this folder from the list" aria-label={`Remove folder ${d.path}`} onClick={() => pin(pinned.filter(x => x !== d.path))}><X size={12}/></button>}
              {!d.sessions.some(h => !h.exit) && <button type="button" className="hs-dir-start" title={`Hide ${name}: it goes to Hidden folders at the end of the list. Nothing is deleted`} aria-label={`Hide folder ${d.path}`} onClick={() => hideFolder(d.path)}><EyeOff size={12}/></button>}
            </header>
            {d.sessions.length > 0 && <ul aria-label={`Sessions in ${d.path}`}>{relationRows(d.sessions, hosted).map(r => row(r, d.path))}</ul>}
            {d.earlier.length > 0 && <div className="hs-earlier">
              <button type="button" className="hs-earlier-toggle" aria-expanded={open} onClick={() => setEarlierOpen(old => { const next = new Set(old); if (next.has(d.path)) next.delete(d.path); else next.add(d.path); return next; })}>
                {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<History size={11}/> Earlier · {d.earlier.length} · last {formatAge(d.earlier[0].modified)}
              </button>
              {open && <ul aria-label={`Earlier sessions in ${d.path}`}>
                {d.earlier.slice(0, 12).map(r => { const sub = subfolderTag(d.path, r.cwd); return <li key={r.id} className="hs-earlier-row">
                  <button type="button" className="hs-item hs-resume" disabled={!status || starting} title={`Continue this ${r.agent === 'claude' ? 'Claude' : 'Codex'} session ${sub ? `in ${r.cwd}` : 'here'}${maybeOpenElsewhere(r, Date.now()) ? '. It changed minutes ago: close it in its other terminal first' : ''}\n${r.id}`} onClick={() => void start(undefined, r.cwd, r.id)}>
                    <EarlierRow agent={r.agent} title={titles[r.id] || r.title || `${r.agent === 'claude' ? 'Claude' : 'Codex'} session`} modified={r.modified} note={maybeOpenElsewhere(r, Date.now()) ? ' · open elsewhere?' : ''}/>
                    {sub && <small className="hs-subdir-line"><span className="hs-rel subdir" title={`In ${sub.path}`}>{sub.tag}</span></small>}
                  </button>
                  <button type="button" className="hs-dir-start hs-earlier-hide" title="Hide this session from the list. Its conversation stays on disk and can still be found by search" aria-label={`Hide session ${titles[r.id] || r.title || r.id}`} onClick={() => hideSession(r.id)}><EyeOff size={11}/></button>
                </li>; })}
                {d.earlier.length > 12 && <li className="hs-earlier-more">{d.earlier.length - 12} older: use search</li>}
                {d.hiddenEarlier > 0 && <li className="hs-earlier-more"><button type="button" className="hs-earlier-unhide" onClick={() => showFolder(d.path, 'sessions hidden', sessionsOf(d.path))}>{d.hiddenEarlier} hidden · show them</button></li>}
              </ul>}
            </div>}
          </li>;
        })}
      </ul>
      {sections.length > shown.length && <button type="button" className="hs-more-folders" onClick={() => setAllHistory(true)}>{sections.length - shown.length} more folders with history</button>}
      {ended.length > 0 && <button type="button" className="hs-more-folders hs-cleanup" onClick={() => setRemoving(ended.map(h => h.id))}><Trash2 size={11}/> Remove ended sessions · {ended.length}</button>}
      {hiddenFolders.length > 0 && <div className="hs-hidden">
        <button type="button" className="hs-earlier-toggle" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen(o => !o)}>
          {hiddenOpen ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<EyeOff size={11}/> Hidden folders · {hiddenFolders.length}
        </button>
        {hiddenOpen && <ul aria-label="Hidden folders">
          {hiddenFolders.map(({ section: d, reason }) => {
            const name = tildePath(d.path, home);
            return <li key={d.path} className="hs-hidden-row">
              <span className="hs-hidden-path" title={d.path}>{shortPath(name)}</span>
              <small className={`hs-hidden-why ${reason.replace(' ', '-')}`}>{HIDDEN_REASON[reason]}</small>
              <button type="button" className="hs-dir-start" title={`Show ${name} in the list again`} aria-label={`Show folder ${d.path}`} onClick={() => showFolder(d.path, reason, sessionsOf(d.path))}><Eye size={12}/></button>
            </li>;
          })}
          {liveList.hideNoise && <li className="hs-earlier-more">Folders that are gone and agents' temporary folders are left out by themselves; turn that off in Settings → Harnesses.</li>}
        </ul>}
      </div>}
      {removing && <ConfirmDialog title={`Remove ${removing.length} ended session${removing.length === 1 ? '' : 's'} from the list?`} confirmLabel={`Remove ${removing.length}`}
        onCancel={() => setRemoving(null)} onConfirm={() => { const ids = removing; setRemoving(null); removeEnded(ids); }}>
        <p>Their terminal output in Agent MCR goes with them. Their conversations stay on disk with Claude Code and Codex: you find them under their folder's Earlier sessions and in Journal, and can resume them.</p>
      </ConfirmDialog>}
      {!sections.length && status && <p className="hs-empty">No sessions yet. Add a project above and start an agent in it; it keeps running when you close the app.</p>}
      </div>
    </Pane>
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
      renderSessionRow: (h: Hosted) => row({ session: h, depth: 0, executors: 0 }),
      openNewAgentInDir: (dir: string) => { setCwd(dir); setNewAgentOpen(true); },
      renderSupervisorMenu: (sup: Hosted) => <RowMenu label="the supervisor" actions={actions(sup)}/>,
    },
  };

  // Board's and Slack's panels in Live (the app plugin's, for every view of Sessions with panes)
  const panels = usePaneTypes(pluginRegistry.workbench, 'live');

  // The view's tools in the window's top bar: Back and Forward (MCR-108), then the Layouts plugin's presets
  const layoutBar = layoutBarOverride?.({ leavesCount: slots.length, controller, defaultRender: () => null });
  const nameAt = (index: number | null) => index === null ? '' : names.get(history.entries[index]) ?? '';
  const tools = (opened.length > 0 || layoutBar) && <ShellTools>
    <div className="wb-tool-group hs-live-tools">
      {opened.length > 0 && <div className="hs-history" role="toolbar" aria-label="Session history">
        <button type="button" className="wb-tool" aria-label="Back" disabled={backTo === null} title={backTo === null ? 'Back' : `Back to ${nameAt(backTo)} (${BACK_KEYS})`} onClick={goBack}><ArrowLeft size={14}/></button>
        <button type="button" className="wb-tool" aria-label="Forward" disabled={forwardTo === null} title={forwardTo === null ? 'Forward' : `Forward to ${nameAt(forwardTo)} (${FORWARD_KEYS})`} onClick={goForward}><ArrowRight size={14}/></button>
      </div>}
      {opened.length > 0 && layoutBar && <span className="wb-tool-separator" aria-hidden="true"/>}
      {layoutBar}
    </div>
  </ShellTools>;

  return <div className="hs-live">
    {newAgentOverride ? newAgentOverride({ open: newAgentOpen, onClose: closeNewAgent, controller, defaultRender: defaultNewAgent }) : defaultNewAgent()}
    {tools}
    <main className="hs-live-layout">
      {(() => {
        const multiPane = slots.length > 1;
        const emptyActions = pluginRegistry.getEmptyActions();
        const emptyPaneOverride = pluginRegistry.getOverride('live:empty-pane');
        // A leaf's pane: a session (header, cockpit, terminal, usage), a plugin's pane, or the empty pane.
        // A session's pane is kept alive by the layout while a leaf shows it. Its terminal is there only
        // while the pane is visible, its body is on screen with some size and the Live view is shown
        // (MCR-139, MCR-140): a hidden one detaches from the runner and goes to the keep (TerminalPane's
        // `keep`; the panes' sessions are protected there), and shown again takes only what it missed.
        // A terminal kept attached for every session ever opened parsed all their output for good, and one
        // mounted hidden told the agent 80×24. (`parked`, a pane no leaf shows, no longer happens.)
        const renderPane = (node: LivePane, parked = false, visible = true): React.ReactNode => {
          const sessItem = node.item?.kind === 'session' ? node.item : null;
          const h = sessItem ? hosted.find(x => x.id === sessItem.id) : undefined;
          const pluginKind = node.item ? (node.item.kind === 'custom' ? node.item.type : node.item.kind) : '';
          const pluginPane = !h && pluginKind ? pluginRegistry.getPaneType(pluginKind) : undefined;
          const isFocused = node.id === focusedPane;
          const pickCandidates = hosted.filter(x => !x.exit && !assignedSessions.has(x.id));
          const defaultEmptyRender = () => (
            <>
              <header className="hs-pane-title hs-pane-title--empty">
                <span className="hs-empty-dot" aria-hidden="true"/>
                <strong><PaneTitle>Empty pane</PaneTitle></strong>
                <div className="hs-pane-tools">
                  {paneTools?.({ leafId: node.id, multiPane, controller })}
                  <PaneMenu/>
                </div>
              </header>
              {/* The only pane a session can open in: the list is the picker */}
              {slots.length === 1 && !node.item ? <div className="hs-placeholder"><p>Select a session, or start one.</p></div> : <div className="hs-pane-empty">
                <div className="hs-empty-card">
                  <div className="hs-empty-head hs-empty-head--split">
                    <div>
                      <h3>Open in this pane</h3>
                      <p>Pick a workspace session, launch a new agent, or show a panel.</p>
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
                                  <strong>{sessionLabel(cand)}</strong>
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

                  <PanelChoices heading="Or show a panel here"/>
                </div>
              </div>}
            </>
          );

          return (
            // No key: a kept-alive pane moves between leaves (and in from the parking); a key that changed would remount its terminal
            <div className="hs-pane" hidden={parked} onMouseDown={parked ? undefined : () => focusPane(node.id)}>
              {h ? (() => {
                const defaultHeader = () => (
                  <header className="hs-pane-title">
                    <span className={`hs-dot ${hostedState(h)}`} aria-label={STATE_LABEL[hostedState(h)]}/>
                    <AgentMark profile={h.harness?.profile || h.meta.profile || ''}/>
                    <strong>{sessionLabel(h)}</strong>
                    <span title={h.cwd}>{h.cwd}</span>
                    <ProgramLine hosted={h} compact/>
                    <div className="hs-pane-tools">
                      <Button variant="ghost" size="xs" icon={<BarChart3 size={13}/>} aria-pressed={stats} title="Tokens, context size, tools and skills of this session" onClick={toggleStats}>Usage</Button>
                      {paneTools?.({ leafId: node.id, multiPane, controller })}
                      <PaneMenu/>
                    </div>
                  </header>
                );
                return (
                  <>
                    {!parked && (sessionHeaderOverride
                      ? sessionHeaderOverride({ session: h, leafId: node.id, multiPane, isFocused, statsOpen: stats, toggleStats, controller, defaultRender: defaultHeader })
                      : defaultHeader())}
                    {/* The cockpit sits over the Supervisor's own terminal and nowhere else (MCR-96) */}
                    {!parked && !h.exit && isSupervisor(h) && <CockpitPanel active={active} hosted={hosted} label={sessionLabel} onSession={follow}/>}
                    {/* The terminal attaches only while its body is on screen with some size (MCR-140) */}
                    <PaneBody watching={opened.includes(h.id) && active && visible} terminal={() => {
                      // Only the selected, focused pane takes the keyboard on mount, or a link's focus
                      const selectedPane = selected === h.id && focusedItem?.kind === 'session' && focusedItem.id === h.id;
                      return <TerminalPane key={h.id} id={h.id} name={sessionLabel(h)} active={active} focusOnMount={selectedPane} onQuit={() => { closing.current.add(h.id); void refresh(); }} isSession={isSession} onSession={follow} focusAt={selectedPane && linked?.id === h.id ? linked.at : undefined} onFocused={() => setLinked(l => l?.id === h.id ? null : l)}/>;
                    }}>
                      {!parked && stats && isFocused && <SessionStats session={h} active={active}/>}
                    </PaneBody>
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

        /** A split of a pane a session can open in: an empty pane beside it, chosen (as Live's own split does). */
        const splitHere = ({ leaf }: PaneContext, dir: 'row' | 'col') => { if (leaf) splitPane(leaf.id, dir); };
        const sessionTitle = (pane: PaneRef) => {
          const item = itemOf(pane);
          const h = item?.kind === 'session' ? hosted.find(x => x.id === item.id) : undefined;
          return h ? sessionLabel(h) : undefined;
        };
        // Live's panes: the list, Board's and Slack's panels (the app plugin's, for every view of Sessions), the sessions', plugins' and empty panes
        const paneTypes: Record<string, PaneType> = {
          [LIVE_LIST]: {
            type: LIVE_LIST, label: 'session list', title: 'Sessions', icon: <ListTree size={14}/>, switchable: true, singleton: true, collapsible: true, min: { w: LIST_MIN_WIDTH },
            render: () => sidebarOverride ? sidebarOverride({ controller: sidebarController, defaultRender: defaultSidebar }) : defaultSidebar(),
          },
          ...panels,
          [SESSION_PANE]: {
            type: SESSION_PANE, label: 'session pane', title: 'Session', paneTitle: sessionTitle, keepAlive: true, min: PANE_MIN, split: splitHere,
            render: ({ pane, leaf, visible }) => renderPane({ id: leaf?.id ?? `bg:${pane.key}`, item: itemOf(pane) }, !leaf, visible),
          },
          [CUSTOM_PANE]: {
            type: CUSTOM_PANE, label: 'pane', min: PANE_MIN, split: splitHere,
            render: ({ pane, leaf }) => renderPane({ id: leaf?.id ?? '', item: itemOf(pane) }),
          },
          [EMPTY_PANE]: {
            type: EMPTY_PANE, label: 'empty pane', title: 'Empty pane', icon: <SquareDashed size={14}/>, placeholder: true, min: PANE_MIN, split: splitHere,
            render: ({ leaf }) => renderPane({ id: leaf?.id ?? '', item: null }),
          },
        };

        return (
          <LayoutView
            className="hs-panes hs-layout-root"
            layout={drawn}
            onChange={applyDrawn}
            focusedLeaf={focusedPane}
            onFocusLeaf={focusPane}
            onReset={resetLayout}
            paneTypes={paneTypes}
            renderEmpty={(leaf) => renderPane({ id: leaf.id, item: null })}
          />
        );
      })()}
    </main>
  </div>;
}
