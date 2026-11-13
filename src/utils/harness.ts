import { Channel, invoke } from '@tauri-apps/api/core';

/** A launch profile held by the backend; the webview can only pick one by id. */
export interface Profile { id: string; label: string; command: string }
export interface HostedExit { code: number; signal: string | null; at: number }
/** A terminal the runner hosts (`runner::Info`). */
export interface Hosted {
  id: string; pid: number | null; argv: string[]; cwd: string; started: number;
  cols: number; rows: number; title: string; lastOutput: number;
  exit: HostedExit | null; meta: Record<string, string>;
}
export interface HarnessStatus { runner: { protocol: number; pid: number; version: string; exe: string }; profiles: Profile[]; home: string }

export const harnessApi = {
  status: () => invoke<HarnessStatus>('harness_status'),
  list: () => invoke<{ sessions: Hosted[] }>('harness_list').then(r => r.sessions),
  spawn: (profile: string, cwd: string, cols: number, rows: number) => invoke<Hosted>('harness_spawn', { profile, cwd, cols, rows }),
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
  return h.meta.label || h.argv[h.argv.length - 1]?.replace(/^exec /, '') || h.id;
}

export function hostedState(h: Hosted): 'running' | 'exited' | 'failed' {
  if (!h.exit) return 'running';
  return h.exit.code === 0 && !h.exit.signal ? 'exited' : 'failed';
}

/** The image in a paste event, if the clipboard holds one and no text. */
export function pastedImage(data: DataTransfer | null): File | null {
  if (!data) return null;
  const items = Array.from(data.items || []);
  if (items.some(i => i.kind === 'string' && i.type === 'text/plain')) return null;
  const image = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
  return image?.getAsFile() ?? null;
}
