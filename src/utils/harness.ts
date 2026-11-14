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
  /** What the agent says it is doing (its `set_status` tool) */
  status?: string;
}
/** A terminal the runner hosts (`runner::Info`), with the service's view of it. */
export interface Hosted {
  id: string; pid: number | null; argv: string[]; cwd: string; started: number;
  cols: number; rows: number; title: string; lastOutput: number;
  exit: HostedExit | null; meta: Record<string, string>;
  harness?: Tracked; openTasks?: number;
  /** Messages from other sessions it hasn't read yet */
  unread?: number;
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

export function hostedLabel(h: Hosted): string {
  return h.harness?.name || h.meta.name || h.meta.label || h.argv[h.argv.length - 1]?.replace(/^exec /, '') || h.id;
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
