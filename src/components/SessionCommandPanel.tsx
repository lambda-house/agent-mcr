import { homePath } from '../utils/paths';
import { paletteShortcut, PLATFORM } from '../utils/platform';
import { useMemo, useState } from 'react';
import { Activity, Compass, RefreshCw, Search, Settings, Shield, X } from 'lucide-react';
import { DescList, Kbd, StatusDot, cx } from '@lambda-house/ui';
import { Palette, commandItems, matchesQuery, useMenu, type PaletteItem } from '@lambda-house/workbench';
import { cacheState, compact, contextWindow, formatSessionTitle, matchesSession, sessionDirectories, sessionKey, totalTokens, within, type Session } from '../utils/sessions';
import { formatAge } from '../utils/agent';
import { hostedState, liveSessionLabel, runningFor, shortPath, STATE_LABEL, type Hosted } from '../utils/harness';
import type { TopTabPlugin } from '../plugins/sdk';
import { useStore } from '../store';
import { appMenu } from '../utils/commands';
import AgentMark from './AgentMark';
import { SessionFigures } from './SessionMetrics';
import { EarlierRow, HostedRow, rowIdle, useHostedByConversation } from './SessionRow';
import '../styles/harness.css';
import '../styles/command-panel.css';

export interface SessionCommandPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hideTrigger?: boolean;
  enabled: boolean | null;
  sessions: Session[];
  directory: string;
  onClearDirectory: () => void;
  onSelectSession: (key: string) => void;
  /** Show a hosted session in Live */
  onOpenLive?: (hostedId: string) => void;
  onNavigateView: (viewId: string) => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onEnableAccess: () => void;
  topTabs: TopTabPlugin[];
}

type QuickFilter = 'all' | 'live' | 'codex' | 'claude' | 'working';

const GROUPS = ['Sessions', 'Navigate', 'Actions', 'Commands'];

function statusClass(status?: string): string {
  if (status === 'working') return 'cmd-status cmd-status--working';
  if (status === 'waiting') return 'cmd-status cmd-status--waiting';
  if (status === 'stale') return 'cmd-status cmd-status--stale';
  if (status === 'interrupted') return 'cmd-status cmd-status--interrupted';
  return 'cmd-status cmd-status--idle';
}

/** The harness's state for a hosted conversation; the index's guess from the transcript otherwise. */
const rowStatus = (s: Session, live?: Hosted) => live ? hostedState(live) : s.status;
const statusText = (status: string, live?: Hosted) => live ? STATE_LABEL[hostedState(live)] : status;

/** Context and cache spelled out for the preview; the row shows them as bare figures. */
function contextDetail(s: Session): string {
  const c = s.context;
  if (!c || c.now <= 0) return 'Not recorded yet';
  const limit = contextWindow(s);
  const of = limit ? ` of ${compact(limit.size)}${limit.assumed ? ' (assumed)' : ''} · ${Math.round(100 * c.now / limit.size)}%` : '';
  return `${compact(c.now)}${of}${c.compactions ? ` · ${c.compactions} compaction${c.compactions > 1 ? 's' : ''}` : ''}`;
}
function cacheDetail(s: Session, now: number): string | null {
  const cache = cacheState(s, now);
  if (!cache) return null;
  if (cache.warm) return `${cache.assumed ? 'Probably warm' : 'Warm'} for ${runningFor(now, cache.until)}`;
  return cache.assumed ? 'Unknown (Codex records no lifetime)' : `Cold for ${runningFor(cache.until, now)}`;
}

/** The side panel for a session: the facts the row only hints at. */
function SessionPreview({ session, label, status, live, opensInLive }: { session: Session; label: string; status: string; live?: Hosted; opensInLive: boolean }) {
  const cache = cacheDetail(session, Date.now());
  return (
    <>
      <div className="cmd-preview__head">
        <span className="cmd-preview__brand">
          <AgentMark profile={session.provider} size={15} />
          {session.provider}
        </span>
        <span className={cx(statusClass(status), live && 'cmd-status--live')}>
          {live ? <span className={`hs-dot ${status}`} aria-hidden="true" /> : status === 'working' && <StatusDot tone="success" size="sm" />}
          {live ? `In Live · ${statusText(status, live)}` : status}
        </span>
      </div>
      <h3 className="cmd-preview__title">{label}</h3>
      {live?.harness?.status && <p className="cmd-preview__status">{live.harness.status}</p>}
      {live?.harness?.attention && <p className="cmd-preview__status cmd-preview__status--needs">{live.harness.attention.text}</p>}
      <SessionFigures session={session} />
      <DescList
        items={[
          ...(label !== formatSessionTitle(session) ? [{ label: 'Started as', value: formatSessionTitle(session) }] : []),
          { label: 'Workspace', value: session.cwd ? homePath(session.cwd) : 'Unknown', mono: true },
          { label: 'Model', value: session.model ? `${session.model}${session.effort ? ` · ${session.effort}` : ''}` : 'Unknown' },
          { label: 'Context', value: contextDetail(session) },
          ...(cache ? [{ label: 'Cache', value: cache }] : []),
          { label: 'Tokens', value: session.usageKnown ? compact(totalTokens(session.usage)) : 'Unknown' },
          { label: 'Events', value: session.eventCount.toLocaleString() },
          { label: 'Updated', value: session.modified ? formatAge(session.modified) : 'Unknown' },
        ]}
      />
      <div className="cmd-preview__footer">
        <Kbd>↵</Kbd> {opensInLive ? 'Show in Live' : 'Open session inspector'}
      </div>
    </>
  );
}

/**
 * The command panel: the workbench's Palette with the sessions (drawn as the
 * Live list draws them, under their folders), the views, a few actions and
 * the app's commands. It opens through the command app.commandPalette
 * (Ctrl+Shift+P, ⇧⌘P); it has no key of its own.
 */
export default function SessionCommandPanel({
  open,
  onOpenChange,
  hideTrigger = false,
  enabled,
  sessions,
  directory,
  onClearDirectory,
  onSelectSession,
  onOpenLive,
  onNavigateView,
  onOpenSettings,
  onRefresh,
  onEnableAccess,
  topTabs,
}: SessionCommandPanelProps) {
  // Hosted sessions, asked for each time the panel opens: their names and states win over the index's
  const liveByKey = useHostedByConversation(open);
  const menu = useMenu(appMenu);
  const [query, setQuery] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');

  const shortcut = paletteShortcut(PLATFORM);
  const close = () => {
    onOpenChange(false);
    setQuery('');
  };

  const scopedSessions = useMemo(() => {
    if (!enabled) return [];
    return sessions.filter(
      (s) => !directory || sessionDirectories(s).some((p) => within(p, directory)),
    );
  }, [enabled, sessions, directory]);

  const counts = useMemo(
    () => ({
      all: scopedSessions.length,
      live: scopedSessions.filter((s) => liveByKey.has(sessionKey(s))).length,
      codex: scopedSessions.filter((s) => s.provider === 'codex').length,
      claude: scopedSessions.filter((s) => s.provider === 'claude').length,
      working: scopedSessions.filter((s) => rowStatus(s, liveByKey.get(sessionKey(s))) === 'working').length,
    }),
    [scopedSessions, liveByKey],
  );

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return [];
    const next: PaletteItem[] = [];

    if (enabled) {
      const matchingSessions = scopedSessions
        .filter((s) => {
          const live = liveByKey.get(sessionKey(s));
          if (quickFilter === 'live' && !live) return false;
          if (quickFilter === 'codex' && s.provider !== 'codex') return false;
          if (quickFilter === 'claude' && s.provider !== 'claude') return false;
          if (quickFilter === 'working' && rowStatus(s, live) !== 'working') return false;
          // A hosted session is found by the name it has in Live too
          return matchesSession(s, query) || (!!live && !!query.trim() && liveSessionLabel(live, { [s.id]: formatSessionTitle(s) }).toLowerCase().includes(query.trim().toLowerCase()));
        })
        // Running conversations first; the order is otherwise the index's
        .sort((a, b) => Number(liveByKey.has(sessionKey(b))) - Number(liveByKey.has(sessionKey(a))))
        .slice(0, 30);
      // Under folder headings as in the Live list: a folder stands where its first session stood
      const place = new Map<string, number>();
      for (const s of matchingSessions) if (!place.has(s.cwd)) place.set(s.cwd, place.size);
      matchingSessions.sort((a, b) => place.get(a.cwd)! - place.get(b.cwd)!);

      matchingSessions.forEach((s, i) => {
        const key = sessionKey(s);
        const live = liveByKey.get(key);
        const title = live ? liveSessionLabel(live, { [s.id]: formatSessionTitle(s) }) : formatSessionTitle(s);
        const status = rowStatus(s, live);
        // The folder is a heading over its sessions, as in the Live list, not a part of each row
        const heading = matchingSessions[i - 1]?.cwd !== s.cwd;
        next.push({
          id: `session:${key}`,
          group: 'Sessions',
          label: title,
          // The heading is not part of the option, so the option's name says the folder
          ariaLabel: [title, live ? STATE_LABEL[hostedState(live)] : '', s.cwd ? `in ${homePath(s.cwd)}` : ''].filter(Boolean).join(', '),
          className: cx('cmd-item--session', !live && 'hs-resume', live && rowIdle(live) && 'idle'),
          heading: heading
            ? <div className="cmd-dir" title={s.cwd} aria-hidden="true"><span className="hs-dir-path">{s.cwd ? shortPath(homePath(s.cwd)) : 'Unknown folder'}</span></div>
            : undefined,
          // The row of the Live list: the live one for a conversation that runs now, the earlier one otherwise
          row: live
            ? <HostedRow hosted={live} label={title} session={s}/>
            : <EarlierRow agent={s.provider} title={title} modified={s.modified}/>,
          preview: <SessionPreview session={s} label={title} status={status} live={live} opensInLive={!!live && !!onOpenLive} />,
          run: () => {
            if (live && onOpenLive) onOpenLive(live.id);
            else onSelectSession(key);
          },
        });
      });
    }

    const nav: PaletteItem[] = [
      { id: 'nav:live', group: 'Navigate', label: 'Live workspace', hint: 'Active agents & panes', icon: <Compass size={14} />, run: () => onNavigateView('live') },
      ...topTabs.map((t) => ({
        id: `nav:plugin:${t.id}`, group: 'Navigate', label: t.label, hint: t.title || 'Plugin view', icon: <Compass size={14} />, run: () => onNavigateView(t.id),
      })),
      { id: 'nav:settings', group: 'Navigate', label: 'Settings', hint: 'Connections, memories, agent access', icon: <Settings size={14} />, run: onOpenSettings },
    ];
    const actions: PaletteItem[] = enabled
      ? [
        { id: 'action:refresh', group: 'Actions', label: 'Refresh session index', hint: 'Rescan local transcripts', icon: <RefreshCw size={14} />, run: onRefresh },
        { id: 'action:history-view', group: 'Actions', label: 'Open session inspector', hint: 'Full transcript & filters view', icon: <Activity size={14} />, run: () => onNavigateView('history') },
      ]
      : [
        { id: 'action:enable', group: 'Actions', label: 'Enable session access', hint: 'Connect local Codex & Claude transcripts', icon: <Shield size={14} />, run: onEnableAccess },
      ];
    for (const entry of [...nav, ...actions]) {
      if (matchesQuery(query, entry.label, entry.hint)) next.push(entry);
    }

    // The app's own commands, as its menu offers them now
    return [...next, ...commandItems(menu, useStore.getState(), query)];
  }, [open, enabled, scopedSessions, liveByKey, quickFilter, query, topTabs, menu, onSelectSession, onOpenLive, onNavigateView, onOpenSettings, onRefresh, onEnableAccess]);

  const filters = (
    <>
      <div className="cmd-pills" role="group" aria-label="Quick filter">
        {(['all', 'live', 'codex', 'claude', 'working'] as QuickFilter[]).map((f) => (
          <button key={f} type="button" className={cx('cmd-pill', quickFilter === f && 'cmd-pill--active')} onClick={() => setQuickFilter(f)}>
            {f === 'working' && <StatusDot tone="success" size="sm" />}
            {f === 'live' && <span className="hs-dot running" aria-hidden="true" />}
            {f === 'codex' && <AgentMark profile="codex" size={12} />}
            {f === 'claude' && <AgentMark profile="claude" size={12} />}
            <span>{f === 'all' ? 'All' : f === 'live' ? 'In Live' : f === 'working' ? 'Working' : f === 'codex' ? 'Codex' : 'Claude'}</span>
            {enabled && <span className="cmd-pill__count">{counts[f]}</span>}
          </button>
        ))}
      </div>
      {directory && (
        <span className="cmd-dir-badge" title={directory}>
          <span>in {homePath(directory)}</span>
          <button type="button" aria-label="Search all folders" onClick={onClearDirectory}><X size={11} /></button>
        </span>
      )}
    </>
  );

  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          className="cmd-trigger-btn"
          aria-keyshortcuts={shortcut.aria}
          onClick={() => onOpenChange(true)}
          title={`Search sessions & commands (${shortcut.label})`}
        >
          <Search size={13} aria-hidden="true" />
          <span className="cmd-trigger-btn__label">Search</span>
          <Kbd>{shortcut.label}</Kbd>
        </button>
      )}

      <Palette
        open={open}
        onClose={close}
        query={query}
        onQueryChange={setQuery}
        items={items}
        groups={GROUPS}
        label="Control panel"
        placeholder="Search sessions, tickets, models, or commands…"
        toolbar={filters}
        showPreview
        emptyPreview={<p className="cmd-preview__text">Select a session or command to preview details.</p>}
      />
    </>
  );
}
