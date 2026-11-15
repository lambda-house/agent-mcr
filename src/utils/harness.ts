import { Channel, invoke } from '@tauri-apps/api/core';

/** A launch profile held by the backend; the webview can only pick one by id. */
export interface Profile { id: string; label: string; command: string }
export interface HostedExit { code: number; signal: string | null; at: number }
/** Why a session needs the person: a prompt only they may answer, or a notification. */
export interface Attention { kind: 'permission' | 'notification'; text: string; since: number }
/** What the harness service knows about a session (`harness::Tracked`). */
export interface Tracked {
  name: string; profile: string; state: 'starting' | 'working' | 'idle' | 'waiting' | 'unknown' | 'exited';
  since: number; precise: boolean; agentSession: string | null; attention: Attention | null; lastMessage: string | null;
  /** False when `name` is the title the agent gave the session, not a name someone chose */
  named?: boolean;
  /** What the agent says it is doing (its `set_status` tool) */
  status?: string;
}
/** A subagent a Claude session started, as its files show it (activity, not verified liveness). */
export interface Subagent { id: string; description: string; agentType: string; model: string; started: number; lastActivity: number; finished?: boolean }
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
  /** Subagents active in the last hour, newest first */
  subagents?: Subagent[];
}
/** An earlier Claude or Codex session that can continue in the harness. */
export interface Resumable { agent: 'claude' | 'codex'; id: string; cwd: string; modified: number }
export interface HarnessStatus {
  runner: { protocol: number; pid: number; version: string; exe: string }; profiles: Profile[]; home: string;
  /** Run once in a terminal to give an outside agent the supervisor tools */
  supervisorCommand?: string;
}

export const harnessApi = {
  status: () => invoke<HarnessStatus>('harness_status'),
  list: () => invoke<{ sessions: Hosted[] }>('harness_list').then(r => r.sessions),
  spawn: (profile: string, cwd: string, cols: number, rows: number, resume?: string) => invoke<Hosted>('harness_spawn', { profile, cwd, cols, rows, resume }),
  /** The hosted supervisor session: the running one, or a new one */
  supervisor: (cols: number, rows: number) => invoke<Hosted>('harness_supervisor', { cols, rows }),
  resumable: () => invoke<{ sessions: Resumable[] }>('harness_resumable').then(r => r.sessions),
  /** The person looked at a session's notification */
  ack: (id: string) => invoke<void>('harness_ack', { id }),
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

/** The name in a terminal title: without the agent's status glyph and Codex's folder suffix. */
function titleName(h: Hosted): string {
  const text = h.title.replace(/^[^\p{L}\p{N}]+/u, '').split(' | ')[0].trim();
  const folder = h.cwd.split('/').filter(Boolean).pop() ?? '';
  return !text || text === folder || /^(claude code|claude|codex|shell)$/i.test(text) ? '' : text;
}

export const isSupervisor = (h: Hosted) => h.meta.role === 'supervisor';

export function hostedLabel(h: Hosted): string {
  return h.harness?.name || h.meta.name || titleName(h) || h.meta.label || h.argv[h.argv.length - 1]?.replace(/^exec /, '') || h.id;
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

const KIND: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', shell: 'shell' };

/** What to paste into another session so its agent can reach this one. */
export function sessionReference(h: Hosted): string {
  const kind = KIND[h.harness?.profile || h.meta.profile || ''] ?? 'agent';
  return `Agent MCR session "${hostedLabel(h)}" (${kind}, id ${h.id}, pid ${h.pid ?? 'unknown'}, folder ${h.cwd}). Reach it with the mcr tools: ask or send_message with to "${h.id}".`;
}
