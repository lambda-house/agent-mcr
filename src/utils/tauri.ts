import { invoke } from '@tauri-apps/api/core';

/**
 * Check if running inside Tauri environment
 * Tauri 2.0 uses __TAURI_INTERNALS__ instead of __TAURI__
 */
export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;

/**
 * Open native directory picker dialog. The backend adds the chosen folder to
 * the folders the app may read.
 * @returns Selected directory path or null if cancelled
 */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) {
    console.warn('pickDirectory called outside Tauri environment');
    return null;
  }

  return invoke<string | null>('pick_directory');
}

/**
 * Read file contents using Tauri backend
 * @param path File path to read
 * @returns File contents as string
 */
export async function readFile(path: string): Promise<string> {
  if (!isTauri()) {
    console.warn('readFile called outside Tauri environment');
    return `# File Not Available\n\nFile reading requires the Tauri desktop app.`;
  }

  return invoke<string>('read_file', { path });
}

/**
 * Save file using native save dialog
 * @param defaultName Default file name
 * @param content File content to save
 * @param filters File type filters
 * @param title Title of the save dialog
 * @returns Saved file path or null if cancelled
 */
export async function saveFile(
  defaultName: string,
  content: string,
  filters?: { name: string; extensions: string[] }[],
  title = 'Export HTML'
): Promise<string | null> {
  if (!isTauri()) {
    // Fallback for browser: use download link
    const type = /\.html?$/i.test(defaultName) ? 'text/html' : 'text/markdown';
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return defaultName;
  }

  try {
    // Dialog and write both happen in the backend: the webview can't write
    // to a path of its choosing, only where the user picked in the dialog
    return await invoke<string | null>('export_file', {
      defaultName,
      content,
      filters: filters || [{ name: 'HTML', extensions: ['html'] }],
      title,
    });
  } catch (error) {
    // Handle Tauri AppError structure: {code, message, details}
    const message = extractErrorMessage(error);
    throw new Error(message);
  }
}

/**
 * Extract error message from various error formats
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    // Tauri AppError format
    if (typeof obj.message === 'string') {
      return obj.details ? `${obj.message}: ${obj.details}` : obj.message;
    }
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Open a path in the system's default file explorer
 * @param path Directory or file path to open
 */
export async function openInExplorer(path: string): Promise<void> {
  if (!isTauri()) {
    console.warn('openInExplorer called outside Tauri environment');
    return;
  }

  return invoke('open_in_explorer', { path });
}

/** The installed version ("1.1.0"); null outside the app. */
export async function getAppVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

/**
 * Follow a document link to a local file. The backend shows anything that
 * isn't a document in the file manager; a target outside the opened folders
 * and files needs the user's OK in a native dialog first.
 * 'open' means the file is a document the app may read now.
 */
export async function followLocalLink(path: string): Promise<'open' | 'revealed' | 'cancelled'> {
  if (!isTauri()) {
    return 'open';
  }

  return invoke('follow_local_link', { path });
}

/**
 * Open a web or mail link in the default browser / mail app. The backend
 * only accepts http, https and mailto.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  try {
    await invoke('open_external', { url });
  } catch (error) {
    throw new Error(extractErrorMessage(error));
  }
}

/**
 * File/directory metadata for a path
 */
export interface PathInfo {
  size: number;
  modified?: number;
  isReadOnly: boolean;
  isDirectory: boolean;
}

/**
 * Get metadata for a path (used to tell dropped files from dropped folders)
 * @param path File or directory path
 */
export async function getFileInfo(path: string): Promise<PathInfo> {
  if (!isTauri()) {
    throw new Error('getFileInfo requires the Tauri desktop app');
  }

  return invoke<PathInfo>('get_file_info', { path });
}

/** Payload of a native drag & drop event. */
export type DropHandler = (paths: string[]) => void;

/** Receive a command selected from the native application menu. */
export async function onMenuCommand(handler: (id: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string>('menu-command', (event) => handler(event.payload));
}

/**
 * Write a document back to disk. The backend keeps the file's encoding (and
 * refuses files in an unknown non-UTF-8 encoding) and replaces the file
 * atomically, so a crash mid-save never leaves it truncated.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('Saving requires the Tauri desktop app');
  }

  try {
    await invoke('write_file', { path, content });
  } catch (error) {
    throw new Error(extractErrorMessage(error));
  }
}

// ============================================================
// Agent workspace
// ============================================================

export type AgentKind = 'instructions' | 'rule' | 'memory' | 'plan' | 'skill' | 'agent' | 'command';

/** A markdown file a coding agent reads or writes (see src-tauri/src/agent.rs). */
export interface AgentEntry {
  path: string;
  kind: AgentKind;
  title: string;
  description: string | null;
  /** What it belongs to: an agent ("Claude Code"), a project folder or a plugin. */
  group: string;
  scope: 'user' | 'project' | 'plugin';
  /** The session folder it belongs to; null for the agents' own files. */
  folder: string | null;
  /** Last change, ms since the epoch. */
  modified: number;
  /** Changed since the user last read it. */
  unread: boolean;
  /** Never read. */
  isNew: boolean;
}

export interface AgentWorkspace {
  enabled: boolean;
  entries: AgentEntry[];
  /** The session folders that were looked through, most recent first. */
  folders: string[];
  /** Changes arrive as `agent-files-changed` events; otherwise poll. */
  watching: boolean;
}

/** The copy of a document kept when it was last read. */
export interface ReadSnapshot {
  path: string;
  content: string;
  readAt: number;
}

export async function getAgentWorkspace(): Promise<AgentWorkspace> {
  if (!isTauri()) return { enabled: false, entries: [], folders: [], watching: false };
  return invoke('agent_workspace');
}

/**
 * Listen for changes to agent files (sent while the workspace is on; they come
 * in bursts, one per file event).
 * @returns unlisten function (no-op outside Tauri)
 */
/**
 * A macOS banner about a session was clicked: the id of that session
 * (MCR-180). The app keeps the click until it is taken, and says only that
 * there is one: a click that launched the app came before this listener, so
 * it is taken once at once as well.
 */
export async function onOpenSession(handler: (id: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const take = () => invoke<string | null>('harness_open_session_take').then(id => { if (typeof id === 'string' && id) handler(id); }).catch(() => {});
  const stop = await listen('harness-open-session', () => { void take(); });
  void take();
  return stop;
}

export async function onAgentFilesChanged(handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen('agent-files-changed', () => handler());
}

/** Asks the user in a native dialog; resolves to whether it is on. */
export async function enableAgentWorkspace(): Promise<boolean> {
  return invoke('enable_agent_workspace');
}

export async function disableAgentWorkspace(): Promise<void> {
  return invoke('disable_agent_workspace');
}

export async function readSnapshot(path: string): Promise<ReadSnapshot | null> {
  if (!isTauri()) return null;
  return invoke('read_snapshot', { path });
}

/** Remember documents as read, as they are on disk now. */
export async function markRead(paths: string[]): Promise<void> {
  if (!isTauri() || paths.length === 0) return;
  return invoke('mark_read', { paths });
}
