import { invoke } from '@tauri-apps/api/core';
import { createJournalStore, type Journal, type JournalHost } from '@lambda-house/journal';
import { sessionApi } from './utils/sessions';
import { isTauri } from './utils/tauri';
import { documentWindowPath } from './utils/documentWindow';

// Agent MCR's journal (@lambda-house/journal): its store, kept in localStorage
// under `agent-mcr-journal` (the layout, each list's filters, each pane's
// session), and its host, the backend's session index. No remote context and
// no Codex control: Agent MCR talks to no outside service. Resuming a session
// in Live is added where the Sessions views are (SessionWorkspace).

export const JOURNAL_STORAGE = 'agent-mcr-journal';

export const journalHost: JournalHost = {
  appName: 'Agent MCR',
  get available() { return isTauri(); },

  access: () => sessionApi.access(),
  enable: () => sessionApi.enable(),
  disable: () => sessionApi.disable(),
  snapshot: () => sessionApi.snapshot(),
  // Only a snapshot whose content changed comes across (MCR-141)
  snapshotSince: (stamp) => sessionApi.snapshotSince(stamp),
  detail: (provider, id) => sessionApi.detail(provider, id),
  events: (provider, id, before) => sessionApi.events(provider, id, before),

  memoryAccess: () => sessionApi.memoryAccess(),
  enableMemories: () => sessionApi.enableMemories(),
  memories: (session) => sessionApi.memories(session),
  readMemory: (key, session) => sessionApi.readMemory(key, session),
  openMemoryWindow: (key, session) => sessionApi.openMemoryWindow(key, session),

  analysis: {
    status: () => invoke('analysis_access'),
    enable: (grant) => invoke<boolean>('enable_analysis', { grant }),
    revoke: () => invoke<void>('revoke_analysis'),
    query: (name, args) => invoke('run_session_analysis', { name, arguments: args }),
  },
};

/** Not in tests that run without a DOM; a memory window has no journal and keeps nothing. */
const storage = typeof localStorage === 'undefined' || documentWindowPath ? null : localStorage;

export const journal: Journal = {
  store: createJournalStore({ storage, name: JOURNAL_STORAGE }),
  host: journalHost,
};
