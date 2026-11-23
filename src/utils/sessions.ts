import { invoke } from '@tauri-apps/api/core';
import type { MemoryCatalog, MemoryDocument, Session, SessionEvent, Snapshot } from '@lambda-house/journal';

// The session types and helpers are the journal's (@lambda-house/journal);
// this is Agent MCR's IPC contract with its session index. The journal's host
// (src/journal.ts) is made from it, and the cockpit and Live call it directly.

export {
  basename, cacheState, CODEX_CACHE_S, compact, contextWindow, COOLING_SHARE, directoryTree, family, filterSessions,
  formatSessionTitle, matchesActivity, matchesSession, origin, sessionDirectories, sessionKey, sessionTitle, sessionTooltip,
  sessionTree, shellQuote, sumUsage, totalTokens, within,
  type ActivityWindow, type CacheState, type ContextStats, type DirectoryNode, type MemoryCatalog, type MemoryDocument,
  type MemoryItem, type Session, type SessionEvent, type SessionNode, type Snapshot, type Usage,
} from '@lambda-house/journal';

export const sessionApi = {
  memoryAccess: () => invoke<boolean>('session_memory_access'),
  enableMemories: () => invoke<boolean>('enable_session_memories'),
  memories: (session?: Session) => invoke<MemoryCatalog>('session_memories', { provider: session?.provider, id: session?.id }),
  readMemory: (key: string, session?: Session, openInDocuments = false) => invoke<MemoryDocument>('read_session_memory', { key, provider: session?.provider, id: session?.id, openInDocuments }),
  openMemoryWindow: (key: string, session?: Session) => invoke<void>('open_session_memory_window', { key, provider: session?.provider, id: session?.id }),
  access: () => invoke<boolean>('session_access'),
  enable: () => invoke<boolean>('enable_sessions'),
  disable: () => invoke<void>('disable_sessions'),
  events: (provider: string, id: string, before: number) => invoke<SessionEvent[]>('session_events', { provider, id, before }),
  stats: (provider: string, id: string) => invoke<Session>('session_stats', { provider, id }),
  detail: (provider: string, id: string) => invoke<Session>('session_details', { provider, id }),
  snapshot: () => invoke<Snapshot>('sessions_snapshot'),
};
