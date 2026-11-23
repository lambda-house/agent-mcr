import { Segmented } from '@lambda-house/ui';
import { useEffect, useMemo, useState } from 'react';
import { ClipboardList, History, MessageSquare, Terminal } from 'lucide-react';
import { useStore as useZustand } from 'zustand';
import { JournalProvider, JournalView, errorText, formatSessionTitle, refreshJournal, type Journal } from '@lambda-house/journal';
import { isTauri } from '../utils/tauri';
import { useStore } from '../store';
import { journal } from '../journal';
import { pluginRegistry, usePluginVersion } from '../plugins';
import '@lambda-house/journal/journal.css';
import '../styles/sessions.css';
import { ShellTools } from '@lambda-house/workbench';
import { HostedByConversation, JournalRow, useHostedByConversation } from './SessionRow';
import { harnessApi, slackApi } from '../utils/harness';
import LiveWorkspace from './LiveWorkspace';
import BoardView from './BoardView';
import SlackView from './SlackView';

const VIEW_KEY = 'agent-mcr.sessions.view';
function savedView(): string {
  try { return localStorage.getItem(VIEW_KEY) || 'live'; } catch { return 'live'; }
}

/**
 * The Sessions surface: Live, the Journal (@lambda-house/journal), Board,
 * Slack and the plugins' views. The journal stays mounted while another view
 * is shown: its snapshot names Live's sessions and feeds the palette.
 */
export default function SessionWorkspace({ active = true }: { active?: boolean }) {
  usePluginVersion();
  const topTabs = pluginRegistry.getTopTabs();
  const globalOverlays = pluginRegistry.getGlobalOverlays();
  const [view, setViewState] = useState<string>(savedView);
  const [focus, setFocus] = useState<{ id: string; at: number }>();
  const setView = (v: string) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience only */ } };
  const activePluginTab = topTabs.find(t => t.id === view);
  // Posts that wait for the person's approval: shown on the Slack tab from every view
  const [slackWaiting, setSlackWaiting] = useState(0);
  useEffect(() => {
    if (!active || !isTauri()) return;
    const look = () => { if (!document.hidden) slackApi.status().then(s => setSlackWaiting(s.counts.waiting)).catch(() => {}); };
    look();
    const timer = setInterval(look, 4000);
    return () => clearInterval(timer);
  }, [active]);

  const { store } = journal;
  const enabled = useZustand(store, s => s.enabled);
  const sessions = useZustand(store, s => s.snapshot.sessions);
  const directory = useZustand(store, s => s.lists[s.lastList]?.directory ?? '');
  const setDirectory = (path: string) => store.getState().setFilters(store.getState().lastList, { directory: path });
  /** Continue an earlier session in a hosted terminal, in its own folder. */
  const withResume = useMemo<Journal>(() => ({
    store,
    host: { ...journal.host, resume: async (s) => { await harnessApi.spawn('', '', 120, 32, s.id); setView('live'); } },
  }), [store]);

  // The same cleaned names in Live and the command panel, joined by conversation id
  const titles = useMemo(() => Object.fromEntries(sessions.filter(s => !s.parentId).map(s => [s.id, formatSessionTitle(s)])), [sessions]);
  // A found session that runs now is drawn as its Live row
  const live = useHostedByConversation(active && view === 'history' && !!enabled, 5000);
  const searchFolder = (path: string) => { setDirectory(path); setView('history'); };
  const recentDirectories = useMemo(() => [...new Set([...sessions].sort((a, b) => b.modified - a.modified).map(s => s.cwd).filter(Boolean))].slice(0, 30), [sessions]);
  return <section className="session-cockpit">
    {/* The view switch is in the window's top bar; the journal puts its summary there too */}
    <ShellTools>
      <Segmented label="Sessions view" value={view} onChange={setView} options={[
        { value: 'live', label: 'Live', icon: <Terminal size={13}/> },
        ...topTabs.map(t => ({ value: t.id, label: t.label, icon: t.icon, title: t.title })),
        { value: 'history', label: 'Journal', icon: <History size={13}/>, title: 'Find an earlier session: by text, folder, agent or time' },
        { value: 'board', label: 'Board', icon: <ClipboardList size={13}/>, title: 'What sessions reported to you, and the notes they left for each other' },
        { value: 'slack', icon: <MessageSquare size={13}/>, title: 'Slack: what is listened to, what sessions may post, and posts that wait for your approval',
          label: <>Slack <small className="hs-preview">Preview</small>{slackWaiting > 0 && <span className="hs-slack-badge" aria-label={`${slackWaiting} waiting for your approval`}>{slackWaiting}</span>}</> },
      ]}/>
    </ShellTools>
    <div className="hs-live-wrap" hidden={view !== 'live'}><LiveWorkspace active={active && view === 'live'} recentDirectories={recentDirectories} titles={titles} onSearch={enabled ? searchFolder : undefined} focus={focus}/></div>
    {activePluginTab && activePluginTab.render({ active: active && view === activePluginTab.id })}
    {/* Only while Sessions is shown: an overlay may listen for keys (the command panel's Cmd+S), and over Documents those are the editor's */}
    {active && globalOverlays.map(o => o.render({
      enabled,
      sessions,
      directory,
      onClearDirectory: () => setDirectory(''),
      onSelectSession: (key) => { store.getState().show(key); setView('history'); },
      onOpenLive: (id) => { setFocus({ id, at: Date.now() }); setView('live'); },
      onNavigateView: (viewId) => setView(viewId),
      onOpenSettings: () => useStore.getState().setSettingsOpen(true),
      onRefresh: () => void refreshJournal(journal),
      onEnableAccess: async () => { try { store.getState().setEnabled(await journal.host.enable()); } catch (e) { store.getState().setError(errorText(e)); } },
      topTabs,
    }))}
    {view === 'slack' && <SlackView active={active} onOpen={id => { setFocus({ id, at: Date.now() }); setView('live'); }} onWaiting={setSlackWaiting}/>}
    {view === 'board' && <BoardView active={active} onOpen={id => { setFocus({ id, at: Date.now() }); setView('live'); }}/>}
    <div className="hs-journal-wrap" hidden={view !== 'history'}>
      <HostedByConversation.Provider value={live}>
        <JournalProvider journal={withResume} row={JournalRow}>
          <JournalView active={active}/>
        </JournalProvider>
      </HostedByConversation.Provider>
    </div>
  </section>;
}
