import { createContext, useContext, useEffect, useMemo } from 'react';
import { ClipboardList, History, MessageSquare, Terminal } from 'lucide-react';
import { useStore as useZustand } from 'zustand';
import { JournalProvider, JournalView, errorText, formatSessionTitle, refreshJournal, type Journal } from '@lambda-house/journal';
import { isTauri } from '../utils/tauri';
import { useStore } from '../store';
import { journal } from '../journal';
import { pluginRegistry, usePluginVersion } from '../plugins';
import '@lambda-house/journal/journal.css';
import '../styles/sessions.css';
import { ShellViews, useViews, type WorkbenchView } from '@lambda-house/workbench';
import { HostedByConversation, JournalRow, useHostedByConversation } from './SessionRow';
import { harnessApi, slackApi, type Hosted } from '../utils/harness';
import { SESSIONS_VIEWS, useSessionsView } from '../sessionsView';
import LiveWorkspace from './LiveWorkspace';
import PanesView from './PanesView';
import { setSlackWaiting, useSlack } from './SlackView';

/** How often the snapshot of the index is read while Live is shown: it names earlier sessions there, nothing more (MCR-139) */
export const LIVE_SNAPSHOT_MS = 60_000;

/** What the views of Sessions share, from the surface. */
interface Sessions {
  /** Sessions is shown. */
  active: boolean;
  enabled: boolean;
  titles: Record<string, string>;
  recentDirectories: string[];
  /** The journal's search, in one folder. */
  searchFolder: (path: string) => void;
  /** The hosted sessions by conversation, for the journal's rows. */
  live: Map<string, Hosted>;
  /** The journal whose sessions resume in Live. */
  withResume: Journal;
}

const SessionsContext = createContext<Sessions | null>(null);

function useSessions(): Sessions {
  const sessions = useContext(SessionsContext);
  if (!sessions) throw new Error('A view of Sessions is drawn inside SessionWorkspace');
  return sessions;
}

function LiveViewBody() {
  const { active, recentDirectories, titles, enabled, searchFolder } = useSessions();
  const shown = useSessionsView(s => s.view === 'live');
  const focus = useSessionsView(s => s.focus);
  return <div className="hs-live-wrap"><LiveWorkspace active={active && shown} sessionAccess={enabled} recentDirectories={recentDirectories} titles={titles} onSearch={enabled ? searchFolder : undefined} focus={focus}/></div>;
}

function JournalViewBody() {
  const { active, live, withResume } = useSessions();
  const liveShown = useSessionsView(s => s.view === 'live');
  return <HostedByConversation.Provider value={live}>
    <JournalProvider journal={withResume} row={JournalRow}><JournalView active={active} refreshInterval={liveShown ? LIVE_SNAPSHOT_MS : undefined}/></JournalProvider>
  </HostedByConversation.Provider>;
}

/** Slack posts that wait for the person's approval, on the Slack tab from every view. */
function SlackLabel() {
  const slackWaiting = useSlack(s => s.waiting);
  return <>Slack <small className="hs-preview">Preview</small>{slackWaiting > 0 && <span className="hs-slack-badge" aria-label={`${slackWaiting} waiting for your approval`}>{slackWaiting}</span>}</>;
}

/** Agent MCR's views of Sessions (documents.tsx contributes them); the plugins' come between Live and the Journal. */
export const sessionViews: WorkbenchView[] = [
  { surface: 'sessions', id: 'live', order: SESSIONS_VIEWS.live, label: 'Live', icon: <Terminal size={13}/>, keepMounted: 'always', render: () => <LiveViewBody/> },
  // Always mounted: its snapshot names Live's sessions and feeds the palette
  { surface: 'sessions', id: 'history', order: SESSIONS_VIEWS.history, label: 'Journal', icon: <History size={13}/>, title: 'Find an earlier session: by text, folder, agent or time', keepMounted: 'always',
    render: () => <JournalViewBody/> },
  { surface: 'sessions', id: 'board', order: SESSIONS_VIEWS.board, label: 'Board', icon: <ClipboardList size={13}/>, title: 'What sessions reported to you, and the notes they left for each other',
    render: () => <PanesView view="board"/> },
  { surface: 'sessions', id: 'slack', order: SESSIONS_VIEWS.slack, label: <SlackLabel/>, icon: <MessageSquare size={13}/>, title: 'Slack: what is listened to, what sessions may post, and posts that wait for your approval',
    render: () => <PanesView view="slack"/> },
];

/**
 * The Sessions surface: its views, from the plugin registry (Live, the
 * Journal of @lambda-house/journal, Board, Slack and the plugins' views).
 * The journal stays mounted while another view is shown: its snapshot names
 * Live's sessions and feeds the palette.
 */
export default function SessionWorkspace({ active = true }: { active?: boolean }) {
  usePluginVersion();
  const views = useViews(pluginRegistry.workbench, 'sessions');
  const globalOverlays = pluginRegistry.getGlobalOverlays();
  const view = useSessionsView(s => s.view);
  const { show, openLive } = useSessionsView.getState();
  // Posts that wait for the person's approval: shown on the Slack tab from every view; Slack's panes read them while shown
  const showingSlack = view === 'slack';
  useEffect(() => {
    if (!active || showingSlack || !isTauri()) return;
    let live = true;
    const look = () => { if (!document.hidden) slackApi.waiting().then(count => { if (live) setSlackWaiting(count); }).catch(() => {}); };
    look();
    const timer = setInterval(look, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [active, showingSlack]);

  const { store } = journal;
  const enabled = useZustand(store, s => s.enabled);
  const sessions = useZustand(store, s => s.snapshot.sessions);
  const directory = useZustand(store, s => s.lists[s.lastList]?.directory ?? '');
  const setDirectory = (path: string) => store.getState().setFilters(store.getState().lastList, { directory: path });
  /** Continue an earlier session in a hosted terminal, in its own folder, and show that one in Live. */
  const withResume = useMemo<Journal>(() => ({
    store,
    host: { ...journal.host, resume: async (s) => { const resumed = await harnessApi.spawn('', '', 120, 32, s.id); openLive(resumed.id); } },
  }), [store, openLive]);

  // The same cleaned names in Live and the palette, joined by conversation id
  const titles = useMemo(() => Object.fromEntries(sessions.filter(s => !s.parentId).map(s => [s.id, formatSessionTitle(s)])), [sessions]);
  // A found session that runs now is drawn as its Live row
  const live = useHostedByConversation(active && view === 'history' && !!enabled, 5000);
  const searchFolder = (path: string) => { setDirectory(path); show('history'); };
  const recentDirectories = useMemo(() => [...new Set([...sessions].sort((a, b) => b.modified - a.modified).map(s => s.cwd).filter(Boolean))].slice(0, 30), [sessions]);
  const shared: Sessions = { active, enabled: !!enabled, titles, recentDirectories, searchFolder, live, withResume };
  return <section className="session-cockpit">
    <SessionsContext.Provider value={shared}>
      {/* The view switch goes into the window's top bar, and each view's tools while it is shown */}
      <ShellViews label="Sessions view" views={views} value={view} onChange={show}/>
    </SessionsContext.Provider>
    {/* Only while Sessions is shown: an overlay may listen for keys, and over Documents those are the editor's */}
    {active && globalOverlays.map(o => o.render({
      enabled,
      sessions,
      directory,
      onClearDirectory: () => setDirectory(''),
      onSelectSession: (key) => { store.getState().show(key); show('history'); },
      onOpenLive: openLive,
      onNavigateView: show,
      onOpenSettings: () => useStore.getState().setSettingsOpen(true),
      onRefresh: () => void refreshJournal(journal),
      onEnableAccess: async () => { try { store.getState().setEnabled(await journal.host.enable()); } catch (e) { store.getState().setError(errorText(e)); } },
    }))}
  </section>;
}
