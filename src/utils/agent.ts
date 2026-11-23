import { useStore } from '../store';
import { getAgentWorkspace, markRead, readFile, type AgentEntry, type AgentKind } from './tauri';
import { useReader } from '../reader';

// ============================================================
// Agent workspace: refresh and read state
// ============================================================

export const AGENT_SECTIONS: { kind: AgentKind; label: string }[] = [
  { kind: 'instructions', label: 'Instructions' },
  { kind: 'rule', label: 'Rules' },
  { kind: 'memory', label: 'Memory' },
  { kind: 'plan', label: 'Plans' },
  { kind: 'skill', label: 'Skills' },
  { kind: 'agent', label: 'Agents' },
  { kind: 'command', label: 'Commands' },
];

let refreshing: Promise<boolean> | null = null;
let watching = false;

/** Whether the backend reports changes as they happen (else poll). */
export function agentFilesWatched(): boolean {
  return watching;
}

/**
 * Scan the agent files again. Open documents that changed on disk (and have
 * no unsaved edits) are reloaded, so a memory file an agent just wrote shows
 * its new text. Resolves to whether the workspace is on.
 */
export function refreshAgentWorkspace(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const { agentEntries: previous, setAgentEntries } = useStore.getState();
      const { documents, reloadDocument } = useReader.getState();
      const workspace = await getAgentWorkspace();
      watching = workspace.watching;
      const before = new Map(previous.map((e) => [e.path, e.modified]));
      setAgentEntries(workspace.entries, workspace.folders ?? []);
      const changedOpen = workspace.entries.filter(
        (e) => documents[e.path] && before.has(e.path) && before.get(e.path) !== e.modified
      );
      await Promise.all(changedOpen.map(async (entry) => {
        try {
          reloadDocument(entry.path, await readFile(entry.path));
        } catch (error) {
          console.error('Failed to reload agent file:', error);
        }
      }));
      return workspace.enabled;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** Mark files as read now, and clear their "changed" dots right away. */
export async function markAgentFilesRead(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await markRead(paths);
  const done = new Set(paths);
  const { agentEntries, setAgentEntries } = useStore.getState();
  setAgentEntries(agentEntries.map((e) => (done.has(e.path) ? { ...e, unread: false, isNew: false } : e)));
}

export interface AgentFolder { path: string; entries: AgentEntry[] }

/**
 * Agent documents by the session folder they belong to, in the order the
 * backend gave the folders (most recent session first). A memory about a
 * subfolder goes to the nearest session folder above it. `user` holds the
 * rest: the agents' own files and memories of folders no session works in.
 */
export function agentFolders(entries: AgentEntry[], folders: string[]): { folders: AgentFolder[]; user: AgentEntry[] } {
  const byPath = new Map<string, AgentEntry[]>(folders.map((f) => [f, []]));
  const user: AgentEntry[] = [];
  for (const entry of entries) {
    const home = entry.folder == null ? undefined : folders
      .filter((f) => entry.folder === f || entry.folder!.startsWith(`${f}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (home) byPath.get(home)!.push(entry);
    else user.push(entry);
  }
  return { folders: folders.map((path) => ({ path, entries: byPath.get(path)! })).filter((f) => f.entries.length > 0), user };
}

export function agentEntryMatches(entry: AgentEntry, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return entry.title.toLowerCase().includes(q)
    || (entry.description?.toLowerCase().includes(q) ?? false)
    || entry.group.toLowerCase().includes(q)
    || entry.path.toLowerCase().includes(q);
}

/** "5 min ago", "yesterday", "12 Mar" (the reader's; it says when a document was last read). */
export { formatAge } from '@lambda-house/reader';
