import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Compass, RefreshCw, Search, Settings, Shield, X } from 'lucide-react';
import { DescList, Kbd, ScrollArea, StatusDot, cx } from '@/ui';
import { cacheState, compact, contextWindow, formatSessionTitle, matchesSession, sessionDirectories, sessionKey, totalTokens, within, type Session } from '../utils/sessions';
import { formatAge } from '../utils/agent';
import { harnessApi, hostedState, liveSessionLabel, runningFor, STATE_LABEL, type Hosted } from '../utils/harness';
import type { TopTabPlugin } from '../plugins/sdk';
import AgentMark from './AgentMark';
import { SessionFigures } from './SessionMetrics';
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

interface CommandEntry {
  id: string;
  group: 'Sessions' | 'Navigate' | 'Actions';
  label: string;
  sub?: string;
  hint?: string;
  provider?: string;
  status?: string;
  session?: Session;
  /** The hosted session running this conversation now */
  live?: Hosted;
  kind: 'session' | 'nav' | 'action';
  onRun: () => void;
}

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
  const [hosted, setHosted] = useState<Hosted[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    harnessApi.list().then(list => { if (live) setHosted(list); }).catch(() => { if (live) setHosted([]); });
    return () => { live = false; };
  }, [open]);
  const liveByKey = useMemo(() => new Map(hosted.filter(h => !h.exit && h.harness?.agentSession)
    .map(h => [`${h.harness?.profile || h.meta.profile}:${h.harness!.agentSession}`, h])), [hosted]);
  const [query, setQuery] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const id = useId();
  const listId = `${id}-list`;

  const close = () => {
    onOpenChange(false);
    setQuery('');
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) {
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

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

  const items = useMemo<CommandEntry[]>(() => {
    const q = query.trim().toLowerCase();
    const next: CommandEntry[] = [];

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

      for (const s of matchingSessions) {
        const key = sessionKey(s);
        const live = liveByKey.get(key);
        const title = live ? liveSessionLabel(live, { [s.id]: formatSessionTitle(s) }) : formatSessionTitle(s);
        const folder = s.cwd ? s.cwd.replace(/^\/(Users|home)\/[^/]+/, '~') : '';
        const age = s.modified ? formatAge(s.modified) : '';
        const metaParts = [folder, s.model, age].filter(Boolean);
        next.push({
          id: `session:${key}`,
          group: 'Sessions',
          label: title,
          sub: metaParts.join(' · '),
          provider: s.provider,
          status: rowStatus(s, live),
          session: s,
          live,
          kind: 'session',
          onRun: () => {
            if (live && onOpenLive) onOpenLive(live.id);
            else onSelectSession(key);
            close();
          },
        });
      }
    }

    const navEntries: CommandEntry[] = [
      {
        id: 'nav:live',
        group: 'Navigate',
        label: 'Live workspace',
        hint: 'Active agents & panes',
        kind: 'nav',
        onRun: () => {
          onNavigateView('live');
          close();
        },
      },
      ...topTabs.map((t) => ({
        id: `nav:plugin:${t.id}`,
        group: 'Navigate' as const,
        label: t.label,
        hint: t.title || 'Plugin view',
        kind: 'nav' as const,
        onRun: () => {
          onNavigateView(t.id);
          close();
        },
      })),
      {
        id: 'nav:settings',
        group: 'Navigate',
        label: 'Settings',
        hint: 'Connections, memories, agent access',
        kind: 'nav',
        onRun: () => {
          close();
          onOpenSettings();
        },
      },
    ];

    for (const entry of navEntries) {
      if (!q || entry.label.toLowerCase().includes(q) || entry.hint?.toLowerCase().includes(q)) {
        next.push(entry);
      }
    }

    const actionEntries: CommandEntry[] = enabled
      ? [
          {
            id: 'action:refresh',
            group: 'Actions',
            label: 'Refresh session index',
            hint: 'Rescan local transcripts',
            kind: 'action',
            onRun: () => {
              onRefresh();
              close();
            },
          },
          {
            id: 'action:history-view',
            group: 'Actions',
            label: 'Open session inspector',
            hint: 'Full transcript & filters view',
            kind: 'action',
            onRun: () => {
              onNavigateView('history');
              close();
            },
          },
        ]
      : [
          {
            id: 'action:enable',
            group: 'Actions',
            label: 'Enable session access',
            hint: 'Connect local Codex & Claude transcripts',
            kind: 'action',
            onRun: () => {
              onEnableAccess();
              close();
            },
          },
        ];

    for (const entry of actionEntries) {
      if (!q || entry.label.toLowerCase().includes(q) || entry.hint?.toLowerCase().includes(q)) {
        next.push(entry);
      }
    }

    return next;
  }, [
    enabled,
    scopedSessions,
    liveByKey,
    quickFilter,
    query,
    topTabs,
    onSelectSession,
    onOpenLive,
    onNavigateView,
    onOpenSettings,
    onRefresh,
    onEnableAccess,
  ]);

  const groups = useMemo(() => {
    const order: CommandEntry['group'][] = ['Sessions', 'Navigate', 'Actions'];
    return order
      .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
      .filter((entry) => entry.items.length > 0);
  }, [items]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const clampedActive = flat.length > 0 ? Math.min(active, flat.length - 1) : 0;
  const activeItem = flat[clampedActive];

  useEffect(() => {
    if (!open || !listRef.current || !activeItem) return;
    const el = listRef.current.querySelector(`[data-index="${clampedActive}"]`) as HTMLElement | null;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, clampedActive, activeItem]);

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((prev) => (flat.length ? (prev + 1) % flat.length : 0));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((prev) => (flat.length ? (prev - 1 + flat.length) % flat.length : 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activeItem?.onRun();
    }
  };

  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          className="cmd-trigger-btn"
          aria-keyshortcuts="Meta+S"
          onClick={() => onOpenChange(true)}
          title="Search sessions & commands (⌘S)"
        >
          <Search size={13} aria-hidden="true" />
          <span className="cmd-trigger-btn__label">Search</span>
          <Kbd>⌘S</Kbd>
        </button>
      )}

      {open &&
        createPortal(
          <div
            className="cmd-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div
              className="cmd-panel"
              role="dialog"
              aria-modal="true"
              aria-label="Control panel"
              onKeyDown={onPanelKeyDown}
            >
              <div className="cmd-search">
                <span className="cmd-search__icon" aria-hidden="true">
                  <Search size={16} />
                </span>
                <input
                  ref={inputRef}
                  className="cmd-search__input"
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-activedescendant={activeItem ? `${id}-${activeItem.id}` : undefined}
                  aria-autocomplete="list"
                  aria-label="Search sessions and commands"
                  placeholder="Search sessions, tickets, models, or commands…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                />
                {query && (
                  <button
                    type="button"
                    className="cmd-search__clear"
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery('');
                      setActive(0);
                      inputRef.current?.focus();
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              <div className="cmd-subbar">
                <div className="cmd-pills" role="group" aria-label="Quick filter">
                  {(['all', 'live', 'codex', 'claude', 'working'] as QuickFilter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={cx('cmd-pill', quickFilter === f && 'cmd-pill--active')}
                      onClick={() => {
                        setQuickFilter(f);
                        setActive(0);
                      }}
                    >
                      {f === 'working' && <StatusDot tone="success" size="sm" />}
                      {f === 'live' && <span className="hs-dot running" aria-hidden="true" />}
                      {f === 'codex' && <AgentMark profile="codex" size={12} />}
                      {f === 'claude' && <AgentMark profile="claude" size={12} />}
                      <span>
                        {f === 'all' ? 'All' : f === 'live' ? 'In Live' : f === 'working' ? 'Working' : f === 'codex' ? 'Codex' : 'Claude'}
                      </span>
                      {enabled && <span className="cmd-pill__count">{counts[f]}</span>}
                    </button>
                  ))}
                </div>
                {directory && (
                  <span className="cmd-dir-badge" title={directory}>
                    <span>in {directory.replace(/^\/(Users|home)\/[^/]+/, '~')}</span>
                    <button type="button" aria-label="Search all folders" onClick={onClearDirectory}>
                      <X size={11} />
                    </button>
                  </span>
                )}
              </div>

              <div className="cmd-body">
                <div className="cmd-list-wrap">
                  <ScrollArea
                    autoHeight
                    maxHeight="calc(min(78vh, 720px) - 144px)"
                    style={{ flex: 'none' }}
                    viewRef={listRef as Ref<HTMLElement>}
                    viewProps={{ className: 'cmd-list', id: listId, role: 'listbox', 'aria-label': 'Commands' }}
                  >
                    {groups.map((entry) => (
                      <div key={entry.group} className="cmd-group" role="group" aria-label={entry.group}>
                        <div className="cmd-group__head" aria-hidden="true">
                          <span className="cmd-group__label">{entry.group}</span>
                          <span className="cmd-group__count">{entry.items.length}</span>
                        </div>
                        {entry.items.map((item) => {
                          const index = flat.findIndex((candidate) => candidate.id === item.id);
                          const isActive = activeItem?.id === item.id;
                          const iconNode =
                            item.kind === 'session' ? (
                              <AgentMark profile={item.provider || 'shell'} size={17} />
                            ) : item.id === 'nav:settings' ? (
                              <Settings size={14} />
                            ) : item.id === 'action:refresh' ? (
                              <RefreshCw size={14} />
                            ) : item.id === 'action:enable' ? (
                              <Shield size={14} />
                            ) : item.kind === 'nav' ? (
                              <Compass size={14} />
                            ) : (
                              <Activity size={14} />
                            );
                          return (
                            <div
                              key={item.id}
                              id={`${id}-${item.id}`}
                              data-index={index}
                              role="option"
                              aria-selected={isActive}
                              className={cx('cmd-item', isActive && 'cmd-item--active')}
                              onMouseMove={() => setActive(index)}
                              onClick={() => item.onRun()}
                            >
                              <span
                                className={cx(
                                  'cmd-item__icon',
                                  item.kind === 'session' && 'cmd-item__icon--logo',
                                  item.kind === 'session' &&
                                    item.provider === 'codex' &&
                                    'cmd-item__icon--codex',
                                )}
                                aria-hidden="true"
                              >
                                {iconNode}
                              </span>
                              <span className="cmd-item__main">
                                <span className="cmd-item__label">{item.label}</span>
                                {item.sub && <span className="cmd-item__sub">{item.sub}</span>}
                              </span>
                              <span className="cmd-item__right">
                                {item.session && <SessionFigures session={item.session} />}
                                {item.status && (
                                  <span className={cx(statusClass(item.status), item.live && 'cmd-status--live')} title={item.live ? 'Running in Live: the harness reports this state' : 'Guessed from the transcript'}>
                                    {item.live ? <span className={`hs-dot ${item.status}`} aria-hidden="true" /> : item.status === 'working' && <StatusDot tone="success" size="sm" />}
                                    {item.session ? statusText(item.status, item.live) : item.status}
                                  </span>
                                )}
                                {item.hint && <span className="cmd-item__hint">{item.hint}</span>}
                                <span className="cmd-item__enter" aria-hidden="true">
                                  <Kbd>↵</Kbd>
                                </span>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                    {flat.length === 0 && (
                      <div className="cmd-empty">
                        Nothing matches <span className="cmd-empty__query">“{query}”</span>
                      </div>
                    )}
                  </ScrollArea>
                </div>

                <aside className="cmd-preview" aria-label="Selection preview">
                  {activeItem?.session ? (
                    <>
                      <div className="cmd-preview__head">
                        <span className="cmd-preview__brand">
                          <AgentMark profile={activeItem.session.provider} size={15} />
                          {activeItem.session.provider}
                        </span>
                        <span className={cx(statusClass(activeItem.status), activeItem.live && 'cmd-status--live')}>
                          {activeItem.live ? <span className={`hs-dot ${activeItem.status}`} aria-hidden="true" /> : activeItem.status === 'working' && <StatusDot tone="success" size="sm" />}
                          {activeItem.live ? `In Live · ${statusText(activeItem.status ?? '', activeItem.live)}` : activeItem.status}
                        </span>
                      </div>
                      <h3 className="cmd-preview__title">{activeItem.label}</h3>
                      {activeItem.live?.harness?.status && <p className="cmd-preview__status">{activeItem.live.harness.status}</p>}
                      {activeItem.live?.harness?.attention && <p className="cmd-preview__status cmd-preview__status--needs">{activeItem.live.harness.attention.text}</p>}
                      <SessionFigures session={activeItem.session} />
                      <DescList
                        items={[
                          ...(activeItem.label !== formatSessionTitle(activeItem.session)
                            ? [{ label: 'Started as', value: formatSessionTitle(activeItem.session) }]
                            : []),
                          {
                            label: 'Workspace',
                            value: activeItem.session.cwd
                              ? activeItem.session.cwd.replace(/^\/(Users|home)\/[^/]+/, '~')
                              : 'Unknown',
                            mono: true,
                          },
                          {
                            label: 'Model',
                            value: activeItem.session.model
                              ? `${activeItem.session.model}${activeItem.session.effort ? ` · ${activeItem.session.effort}` : ''}`
                              : 'Unknown',
                          },
                          { label: 'Context', value: contextDetail(activeItem.session) },
                          ...(cacheDetail(activeItem.session, Date.now()) ? [{ label: 'Cache', value: cacheDetail(activeItem.session, Date.now()) }] : []),
                          {
                            label: 'Tokens',
                            value: activeItem.session.usageKnown
                              ? compact(totalTokens(activeItem.session.usage))
                              : 'Unknown',
                          },
                          {
                            label: 'Events',
                            value: activeItem.session.eventCount.toLocaleString(),
                          },
                          {
                            label: 'Updated',
                            value: activeItem.session.modified
                              ? formatAge(activeItem.session.modified)
                              : 'Unknown',
                          },
                        ]}
                      />
                      <div className="cmd-preview__footer">
                        <Kbd>↵</Kbd> {activeItem.live && onOpenLive ? 'Show in Live' : 'Open session inspector'}
                      </div>
                    </>
                  ) : activeItem ? (
                    <>
                      <div className="cmd-preview__head">
                        <span className="cmd-preview__brand">{activeItem.group}</span>
                      </div>
                      <h3 className="cmd-preview__title">{activeItem.label}</h3>
                      {activeItem.hint && (
                        <p style={{ margin: 0, fontSize: 'var(--fs-12)', color: 'var(--text-muted)' }}>
                          {activeItem.hint}
                        </p>
                      )}
                      <div className="cmd-preview__footer">
                        <Kbd>↵</Kbd> Run command
                      </div>
                    </>
                  ) : (
                    <p style={{ margin: 0, fontSize: 'var(--fs-12)', color: 'var(--text-muted)' }}>
                      Select a session or command to preview details.
                    </p>
                  )}
                </aside>
              </div>

              <div className="cmd-foot" aria-hidden="true">
                <div className="cmd-foot__group">
                  <span className="cmd-foot__keys">
                    <Kbd>↑</Kbd>
                    <Kbd>↓</Kbd> move
                  </span>
                  <span className="cmd-foot__keys">
                    <Kbd>↵</Kbd> open
                  </span>
                  <span className="cmd-foot__keys">
                    <Kbd>esc</Kbd> close
                  </span>
                </div>
                <span>{flat.length} results</span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
