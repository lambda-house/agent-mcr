import { basename } from './paths';
export { tildePath } from './paths';
import { Channel, invoke } from '@tauri-apps/api/core';

/** A launch profile held by the backend; the webview can only pick one by id. */
export interface Profile { id: string; label: string; command: string; optional: boolean; canSupervise: boolean; taskTracking: boolean }
export interface HarnessPreferences { profiles: Profile[]; enabledProfiles: string[]; supervisorProfile: string | null }
export const HARNESS_PREFERENCES_CHANGED = 'harness-preferences-changed';
export interface HostedExit { code: number; signal: string | null; at: number }
/** Why a session needs the person: a prompt only they may answer, or a notification. */
/** `assessment` and `report` come from the agent's own `report` tool: it needs the person, or finished a piece of work. */
export interface Attention { kind: 'permission' | 'assessment' | 'notification'; text: string; since: number; report?: 'needs_human' | 'done' }
/** What the harness service knows about a session (`harness::Tracked`). */
export interface Tracked {
  name: string; profile: string; state: 'starting' | 'working' | 'idle' | 'waiting' | 'unknown' | 'exited';
  since: number; precise: boolean; agentSession: string | null; attention: Attention | null; lastMessage: string | null;
  /** False when `name` is the title the agent gave the session, not a name someone chose */
  named?: boolean;
  /** What the agent says it is doing (its `set_status` tool) */
  status?: string;
  /** The part it plays, in its own words or the supervisor's */
  role?: string;
}
/** A subagent a Claude session started, as its files show it (activity, not verified liveness). */
export interface Subagent { id: string; description: string; agentType: string; model: string; started: number; lastActivity: number; finished?: boolean }
/** A command the agent started in a shell and that is still running (from the process table). */
export interface RunningShell {
  pid: number; command: string; started: number;
  /** Processor seconds used by the shell and everything under it */
  cpu?: number;
  /** Suspended (Ctrl-Z, a debugger) */
  stopped?: boolean;
  /** Since when its processor time has not moved, as the service saw it */
  quietSince?: number;
}
/** A terminal the runner hosts (`runner::Info`), with the service's view of it. */
export interface Hosted {
  id: string; pid: number | null; argv: string[]; cwd: string; started: number;
  cols: number; rows: number; title: string; lastOutput: number;
  exit: HostedExit | null; meta: Record<string, string>;
  harness?: Tracked; openTasks?: number;
  /** Messages from other sessions it hasn't read yet */
  unread?: number;
  /** Live sessions it exchanged messages with in the last day (ids) */
  peers?: string[];
  /** Shell commands of the agent that are running now, oldest first */
  shells?: RunningShell[];
  /** Subagents active in the last hour, newest first */
  subagents?: Subagent[];
}
/** An earlier Claude or Codex session that can continue in the harness. */
export interface Resumable {
  agent: 'claude' | 'codex';
  id: string;
  cwd: string;
  modified: number;
  title?: string;
  role?: string;
  tags?: string[];
}
export interface HarnessStatus {
  runner: { protocol: number; pid: number; version: string; exe: string }; profiles: Profile[]; home: string;
  supervisorProfile?: string | null;
  /** Run once in a terminal to give an outside agent the supervisor tools */
  supervisorCommand?: string;
  /** The operator lets agents outside the harness use the supervisor tools */
  outsideSupervisors?: boolean;
}

/** What an agent told the person with its `report` tool. */
export interface Report { id: string; session: string; name: string; cwd: string; kind: 'needs_human' | 'done'; text: string; created: number }
/** A note on the bulletin board, read by sessions until it expires. */
export interface Note {
  id: string; from: { id: string; name: string }; folder: string; scope: 'folder' | 'all'; text: string;
  posted: number; expires: number; untilItsSessionEnds: boolean; readBy: number;
}
export interface Board { reports: Report[]; notes: Note[] }

/** How long until a moment: "in 20 min", "in 5 h", "in 3 days". */
export function formatUntil(ms: number, now = Date.now()): string {
  const minutes = Math.round((ms - now) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

/**
 * Reports the person has not acted on: the newest report of each session that
 * still carries its own report as its mark.
 */
export function openReports(reports: Report[], hosted: Hosted[]): Set<string> {
  const open = new Set<string>();
  for (const h of hosted) {
    const kind = h.exit ? undefined : h.harness?.attention?.report;
    if (!kind) continue;
    const last = reports.filter(r => r.session === h.id && r.kind === kind).pop();
    if (last) open.add(last.id);
  }
  return open;
}

export const harnessApi = {
  status: () => invoke<HarnessStatus>('harness_status'),
  preferences: () => invoke<HarnessPreferences>('harness_preferences'),
  savePreferences: async (preferences: Omit<HarnessPreferences, 'profiles'>) => {
    const result = await invoke<HarnessPreferences>('harness_preferences', { preferences });
    window.dispatchEvent(new Event(HARNESS_PREFERENCES_CHANGED));
    return result;
  },
  list: () => invoke<{ sessions: Hosted[] }>('harness_list').then(r => r.sessions),
  spawn: (profile: string, cwd: string, cols: number, rows: number, resume?: string) => invoke<Hosted>('harness_spawn', { profile, cwd, cols, rows, resume }),
  /** The hosted supervisor session: the running one, or a new one */
  /** Asks in a native dialog before turning it on; resolves to the setting as it is now */
  outsideSupervisors: (on: boolean) => invoke<boolean>('harness_outside_supervisors', { on }),
  supervisor: (cols: number, rows: number) => invoke<Hosted>('harness_supervisor', { cols, rows }),
  /** End the agent and continue its conversation in a new process; the session id changes */
  restart: (id: string) => invoke<Hosted & { replaced: string; resumed: boolean }>('harness_restart', { id }),
  resumable: () => invoke<{ sessions: Resumable[] }>('harness_resumable').then(r => r.sessions),
  /** What sessions reported to the person, and the live notes of the bulletin board */
  board: () => invoke<Board>('harness_board'),
  removeNote: (note: string) => invoke<void>('harness_note_remove', { note }),
  /** The person looked at a session's notification */
  ack: (id: string, since?: number) => invoke<void>('harness_ack', { id, since }),
  signal: (id: string, signal: 'INT' | 'TERM' | 'HUP' | 'KILL') => invoke<void>('harness_signal', { id, signal }),
  forget: (id: string) => invoke<void>('harness_forget', { id }),
  resize: (id: string, cols: number, rows: number) => invoke<void>('terminal_resize', { id, cols, rows }),
  /** Output arrives as raw bytes; an empty buffer means the stream ended. */
  attach: (id: string, onData: (bytes: Uint8Array) => void) => {
    const output = new Channel<ArrayBuffer>();
    output.onmessage = data => onData(new Uint8Array(data));
    return invoke<number>('terminal_attach', { id, output });
  },
  input: (view: number, data: string) => invoke<void>('terminal_input', { view, data }),
  detach: (view: number) => invoke<void>('terminal_detach', { view }),
  saveImage: (id: string, bytes: ArrayBuffer) => invoke<string>('terminal_save_image', bytes, { headers: { session: id } }),
};

/** Escape a path the way Terminal does when a file is dropped on it. */
export function shellQuote(path: string): string {
  return path.replace(/([^A-Za-z0-9_\-.,:/@+=%^~])/g, '\\$1');
}

const HARNESS_NAME = /^(claude code|claude|codex|antigravity|antigravity cli|agy|pi|opencode|shell|terminal|root)$/i;

/** The name in a terminal title: without the agent's status glyph and Codex's folder suffix. */
function titleName(h: Hosted): string {
  const text = h.title.replace(/^[^\p{L}\p{N}]+/u, '').split(' | ')[0].trim();
  const folder = basename(h.cwd);
  return !text || text === folder || HARNESS_NAME.test(text) ? '' : text;
}

export const isSupervisor = (h: Hosted) => h.meta.role === 'supervisor';

export function hostedLabel(h: Hosted, titles: Record<string, string> = {}): string {
  const name = h.harness?.name?.trim() ?? '';
  const named = h.harness?.named ? name : '';
  const meaningfulName = HARNESS_NAME.test(name) || /^[0-9a-f-]{8,}$/i.test(name) ? '' : name;
  return named || h.meta.name || meaningfulName || h.harness?.role?.trim() || titles[h.harness?.agentSession ?? ''] || titleName(h) || h.meta.label || h.argv[h.argv.length - 1]?.replace(/^exec /, '') || h.id;
}

export type HostedState = 'running' | 'starting' | 'working' | 'idle' | 'waiting' | 'exited' | 'failed';

/** `running` means alive with nothing more known (a shell, or an agent that hasn't reported yet). */
export function hostedState(h: Hosted): HostedState {
  if (h.exit) return h.exit.code === 0 && !h.exit.signal ? 'exited' : 'failed';
  const state = h.harness?.state;
  return state === 'starting' || state === 'working' || state === 'idle' || state === 'waiting' ? state : 'running';
}

export const STATE_LABEL: Record<HostedState, string> = {
  running: 'running', starting: 'starting', working: 'working', idle: 'idle', waiting: 'waiting for you', exited: 'exited', failed: 'failed',
};

/** A session changed this recently may still be open in another terminal. */
export const maybeOpenElsewhere = (r: Resumable, now: number) => now - r.modified < 5 * 60_000;

/** The image in a paste event, if the clipboard holds one and no text. */
export function pastedImage(data: DataTransfer | null): File | null {
  if (!data) return null;
  const items = Array.from(data.items || []);
  if (items.some(i => i.kind === 'string' && i.type === 'text/plain')) return null;
  const image = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
  return image?.getAsFile() ?? null;
}

/** A subagent that wrote to its transcript this recently counts as active. */
export const subagentActive = (a: Subagent, now: number) => now - a.lastActivity < 90_000;

/**
 * The list in groups: sessions that exchanged messages or run in the same
 * folder stand together, in the place of the first of them. A session with
 * neither is a group of one.
 */
export function groupSessions(list: Hosted[]): Hosted[][] {
  const live = new Map(list.filter(h => !h.exit).map(h => [h.id, h]));
  const seen = new Set<string>();
  const groups: Hosted[][] = [];
  for (const h of list) {
    if (seen.has(h.id)) continue;
    const members = new Set<string>([h.id]);
    const queue = h.exit ? [] : [h];
    for (let next = queue.shift(); next; next = queue.shift()) {
      const linked = [...(next.peers ?? []), ...[...live.values()].filter(x => x.cwd === next.cwd).map(x => x.id)];
      for (const id of linked) {
        const peer = live.get(id);
        if (peer && !members.has(id)) { members.add(id); queue.push(peer); }
      }
    }
    members.forEach(id => seen.add(id));
    groups.push(list.filter(x => members.has(x.id)));
  }
  return groups;
}

const KIND: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', shell: 'shell' };

/** What to paste into another session so its agent can reach this one. */
export function sessionReference(h: Hosted, titles: Record<string, string> = {}): string {
  const kind = KIND[h.harness?.profile || h.meta.profile || ''] ?? 'agent';
  return `Agent MCR session "${hostedLabel(h, titles)}" (${kind}, id ${h.id}, pid ${h.pid ?? 'unknown'}, folder ${h.cwd}). Reach it with the mcr tools: ask or send_message with to "${h.id}".`;
}

/** A session whose agent can be ended and started again on the same conversation. */
export const canRestart = (h: Hosted) => !h.exit && ['claude', 'codex'].includes(h.harness?.profile || h.meta.profile || '');

/** How long something has been running, short: 40s, 12m, 3h 5m. */
export function runningFor(started: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A shell whose processor time has not moved for this long is shown as quiet. */
export const SHELL_QUIET_MS = 120_000;

/**
 * Alive, quiet or suspended. Quiet means no processor use: the command may be
 * waiting (the network, a lock, a sleep) or stuck; the two look the same.
 */
export function shellHealth(sh: RunningShell, now: number): 'active' | 'quiet' | 'stopped' {
  if (sh.stopped) return 'stopped';
  return sh.quietSince !== undefined && now - sh.quietSince >= SHELL_QUIET_MS ? 'quiet' : 'active';
}

/** A folder as a section of the Live list: what runs in it, and what ran in it before. */
export interface DirSection { path: string; sessions: Hosted[]; earlier: Resumable[]; pinned: boolean; latest: number }

/**
 * The Live list by folder, in an order that does not move while work goes on:
 * folders with at least one running session first, then the rest, each group
 * sorted by path. A session that starts waiting changes its row, not its place.
 */
export function directorySections(sessions: Hosted[], resumable: Resumable[], pinned: string[]): DirSection[] {
  const by = new Map<string, DirSection>();
  const at = (path: string) => {
    let section = by.get(path);
    if (!section) { section = { path, sessions: [], earlier: [], pinned: pinned.includes(path), latest: 0 }; by.set(path, section); }
    return section;
  };
  pinned.forEach(at);
  for (const h of sessions) { const d = at(h.cwd); d.sessions.push(h); d.latest = Math.max(d.latest, h.started); }
  for (const r of resumable) { const d = at(r.cwd); d.earlier.push(r); d.latest = Math.max(d.latest, r.modified); }
  const active = (d: DirSection) => d.sessions.some(h => !h.exit);
  return [...by.values()].map(d => ({ ...d, earlier: [...d.earlier].sort((a, b) => b.modified - a.modified) }))
    .sort((a, b) => Number(active(b)) - Number(active(a)) || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
}

/** A path for a section heading: the last two folders, since the start is the same everywhere. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/);
  const separator = path.includes('\\') ? '\\' : '/';
  return parts.length > 3 ? `…${separator}${parts.slice(-2).join(separator)}` : path;
}
