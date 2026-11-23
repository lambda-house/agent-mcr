import { basename } from './paths';
import { invoke } from '@tauri-apps/api/core';
export interface Usage { input: number; cached: number; cacheWrite: number; output: number; reasoning: number }
/** What a session's context holds; `toolBytes` is the size of tool output, not tokens. */
export interface ContextStats {
  now: number; first: number; peak: number; window: number; compactions: number; toolBytes: Record<string, number>; skills: Record<string, number>;
  /** Lifetime in seconds of the prompt cache last written (Claude: 300 or 3600); 0 or missing when unrecorded */
  cacheTtl?: number;
  /** When the cache was last refreshed (ms): the latest response of the main conversation */
  cacheAt?: number;
  /** Requests sent after the cache had expired, and their input not served from it */
  coldWakeups?: number; coldTokens?: number;
}
export interface SessionEvent { seq: number; at: string; kind: string; text: string; tool: string | null }
export interface Session {
  id: string; provider: 'codex' | 'claude'; parentId: string | null; forkedFrom?: string | null; origin?: 'human' | 'subagent' | 'automation' | 'unknown'; directories?: string[]; name: string; cwd: string;
  title: string; model: string; effort: string; started: string; updated: string; modified: number;
  status: string; usage: Usage; usageKnown: boolean; models: Record<string, Usage>;
  tools: Record<string, number>; tickets: string[]; memoryRefs: string[]; events: SessionEvent[];
  eventCount: number; malformedLines: number; source: string; turnId: string;
  context?: ContextStats;
}
export interface Snapshot { sessions: Session[]; errors: string[]; scannedFiles: number; pendingFiles: number; indexedAt: number; cachePath?: string | null; restoredFiles?: number; bytesRead?: number; currentDirectory?: string }
export interface MemoryItem { key: string; title: string; provider: string; scope: string; path: string; modified: number; description: string }
export interface MemoryCatalog { entries: MemoryItem[]; notes: string[] }
export interface MemoryDocument { title: string; content: string; provenance: string; note: string }
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
  /** The same scan for a holder of a snapshot: none when what it shows has the stamp held (MCR-141) */
  snapshotSince: (stamp: string) => invoke<{ stamp: string; snapshot: Snapshot | null }>('sessions_snapshot_since', { stamp: stamp || null }),
  /** The same scan, answered with the named sessions only (`provider:id` keys) */
  pick: (keys: string[]) => invoke<Session[]>('sessions_pick', { keys }),
};
export function sessionKey(s: Session): string { return `${s.provider}:${s.id}`; }
export function totalTokens(u: Usage): number { return u.input + u.output; }
export function sumUsage(sessions: Session[]): Usage {
  return sessions.reduce((sum, s) => ({ input: sum.input + s.usage.input, cached: sum.cached + s.usage.cached,
    cacheWrite: sum.cacheWrite + s.usage.cacheWrite, output: sum.output + s.usage.output, reasoning: sum.reasoning + s.usage.reasoning }),
  { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });
}
export function matchesSession(s: Session, query: string): boolean {
  return !query.trim() || [s.title,s.cwd,s.id,s.name,s.model,...s.tickets,...Object.keys(s.tools)].join(' ').toLowerCase().includes(query.toLowerCase().trim());
}
export function family(sessions: Session[], selected: Session): Session[] {
  const ids = new Set([selected.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of sessions) if (s.provider === selected.provider && s.parentId && ids.has(s.parentId) && !ids.has(s.id)) { ids.add(s.id); changed = true; }
  }
  return sessions.filter(s => s.provider === selected.provider && ids.has(s.id));
}
export const compact = (n: number): string => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/**
 * The context limit a session's size is measured against. Codex records it.
 * Claude Code does not: its size is taken as 200K, or 1M once the session has
 * held more than 200K (only the long-context window can), and marked `assumed`.
 */
export function contextWindow(s: Pick<Session, 'provider' | 'context'>): { size: number; assumed: boolean } | null {
  const c = s.context;
  if (!c) return null;
  if (c.window > 0) return { size: c.window, assumed: false };
  if (s.provider !== 'claude' || c.now <= 0) return null;
  return { size: Math.max(c.peak, c.now) > 200_000 ? 1_000_000 : 200_000, assumed: true };
}

/** A warm cache with less than this share of its lifetime left is cooling. */
export const COOLING_SHARE = 0.2;
/**
 * Codex records no cache lifetime and its provider promises none. In local
 * transcripts about nine in ten requests sent within an hour of the one
 * before were still served from the cache, so that long it is taken for warm.
 */
export const CODEX_CACHE_S = 3600;
export interface CacheState {
  warm: boolean; cooling: boolean; ttl: number; until: number;
  /** The lifetime is not recorded (Codex): warm is likely, and past it the state is unknown, not cold */
  assumed: boolean;
}
/**
 * Whether the session's prompt cache is still alive: a message to a warm
 * session reads its context at the cached price, one to a cold session pays
 * for all of it again. Null when the transcript has no response to go by.
 */
export function cacheState(s: Pick<Session, 'context'> & { provider?: string }, now: number): CacheState | null {
  const c = s.context;
  if (!c?.cacheAt) return null;
  const assumed = !c.cacheTtl;
  if (assumed && s.provider !== 'codex') return null;
  const ttl = c.cacheTtl || CODEX_CACHE_S;
  const until = c.cacheAt + ttl * 1000;
  return { warm: now < until, cooling: now < until && until - now < COOLING_SHARE * ttl * 1000, ttl, until, assumed };
}
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function origin(s: Session): string { return s.origin || (s.parentId ? 'subagent' : 'unknown'); }
export function within(path: string, directory: string): boolean {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(directory)) {
    path = path.replace(/\\/g, '/').toLowerCase();
    directory = directory.replace(/\\/g, '/').toLowerCase();
  }
  const root = directory.replace(/[\\/]+$/, '');
  return !root || path === root || (path.startsWith(root) && /^[\\/]/.test(path.slice(root.length)));
}
export function sessionDirectories(s: Session): string[] { return [...new Set([s.cwd, ...(s.directories || [])].filter(Boolean))]; }
export interface ActivityWindow { activeSince?: number; inactiveSince?: number; activeMinutes?: number; inactiveMinutes?: number; now?: number }
export function matchesActivity(s: Session, filter: ActivityWindow): boolean {
  return (!filter.activeSince || s.modified >= filter.activeSince)
    && (!filter.inactiveSince || s.modified <= filter.inactiveSince)
    && (!filter.activeMinutes || (filter.now ?? Date.now()) - s.modified <= filter.activeMinutes * 60_000)
    && (!filter.inactiveMinutes || (filter.now ?? Date.now()) - s.modified >= filter.inactiveMinutes * 60_000);
}
export interface SessionNode { session: Session; children: SessionNode[]; contextOnly: boolean; missingParent: boolean }
/** Keep ancestors of matches visible, but do not include them in filtered totals. Cycles cannot recurse indefinitely. */
export function sessionTree(all: Session[], matches: Session[]): SessionNode[] {
  const byKey = new Map(all.map(s => [sessionKey(s), s]));
  const matched = new Set(matches.map(sessionKey)); const included = new Set(matched);
  for (const s of matches) {
    let cursor: Session | undefined = s; const visited = new Set<string>();
    while (cursor?.parentId) {
      const key = `${cursor.provider}:${cursor.parentId}`;
      if (visited.has(key)) break; visited.add(key); cursor = byKey.get(key);
      if (cursor) included.add(key);
    }
  }
  const children = new Map<string, Session[]>(); const roots: Session[] = [];
  for (const key of included) {
    const s = byKey.get(key); if (!s) continue;
    const parent = s.parentId ? `${s.provider}:${s.parentId}` : '';
    if (parent && included.has(parent) && parent !== key) children.set(parent, [...(children.get(parent) || []), s]);
    else roots.push(s);
  }
  const visited = new Set<string>();
  const walk = (s: Session): SessionNode | null => {
    const key = sessionKey(s); if (visited.has(key)) return null; visited.add(key);
    return { session: s, contextOnly: !matched.has(key), missingParent: !!s.parentId && !byKey.has(`${s.provider}:${s.parentId}`),
      children: (children.get(key) || []).sort((a,b) => b.modified-a.modified).map(walk).filter((n): n is SessionNode => n !== null) };
  };
  const result = roots.sort((a,b) => b.modified-a.modified).map(walk).filter((n): n is SessionNode => n !== null);
  for (const key of included) if (!visited.has(key)) { const s=byKey.get(key); if (s) { const node=walk(s); if (node) result.push(node); } }
  return result;
}
export interface DirectoryNode { path: string; name: string; sessions: Set<string>; children: Map<string, DirectoryNode> }
export function directoryTree(sessions: Session[]): DirectoryNode {
  const root: DirectoryNode = { path: '/', name: 'All recorded locations', sessions: new Set(), children: new Map() };
  for (const s of sessions) for (const path of sessionDirectories(s)) {
    let node=root; node.sessions.add(sessionKey(s));
    for (const match of path.matchAll(/[^\\/]+/g)) {
      const part = match[0];
      let child=node.children.get(part);
      const end = match.index + part.length;
      const prefix = /^[A-Za-z]:$/.test(part) && end === 2 ? path.slice(0, end + 1) : path.slice(0, end);
      if (!child) {child={path:prefix,name:part,sessions:new Set(),children:new Map()};node.children.set(part,child);}
      child.sessions.add(sessionKey(s));node=child;
    }
  }
  return root;
}

const SYSTEM_TITLE_RE =
  /^(?:#\s*AGENTS\.md\s+instructions|<(?:INSTRUCTIONS|environment_context|user_instructions|system)>|<!--)/i;

function projectFromCwd(cwd: string): string {
  if (!cwd) return '';
  return basename(cwd);
}

export function formatSessionTitle(s: Session): string {
  const raw = (s.title || '').trim();
  const afterTag = raw
    .replace(/^[\s\S]*?<\/(?:INSTRUCTIONS|environment_context|user_instructions)>\s*/i, '')
    .trim();
  const candidate = SYSTEM_TITLE_RE.test(raw) ? afterTag : raw;

  if (candidate && !SYSTEM_TITLE_RE.test(candidate)) {
    return candidate.replace(/\s+/g, ' ');
  }

  const userEvent = s.events?.find(
    (e) => e.kind === 'user' && e.text.trim() && !SYSTEM_TITLE_RE.test(e.text.trim()),
  );
  if (userEvent) {
    return userEvent.text.trim().replace(/\s+/g, ' ');
  }

  const project = projectFromCwd(s.cwd);
  const ticket = s.tickets?.[0];
  const meaningfulName =
    s.name && s.name !== 'root' && !/^[0-9a-f-]{8,}$/i.test(s.name) ? s.name : '';

  if (ticket && project) return `${ticket} · ${project}`;
  if (meaningfulName && project) return `${project} · ${meaningfulName}`;
  if (project) return `${project} session`;
  return s.name || s.id;
}
