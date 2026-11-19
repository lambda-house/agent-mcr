import { Channel, invoke } from '@tauri-apps/api/core';

/** A launch profile held by the backend; the webview can only pick one by id. */
export interface Profile { id: string; label: string; command: string; optional: boolean; canSupervise: boolean; taskTracking: boolean }
export interface HarnessPreferences { profiles: Profile[]; enabledProfiles: string[]; supervisorProfile: string | null }
export const HARNESS_PREFERENCES_CHANGED = 'harness-preferences-changed';
export interface HostedExit { code: number; signal: string | null; at: number }
/** Why a session needs the person: a prompt only they may answer, or a notification. */
/** `assessment` and `report` come from the agent's own `report` tool: it needs the person, or finished a piece of work. */
export interface Attention { kind: 'permission' | 'assessment' | 'notification'; text: string; since: number; report?: 'needs_human' | 'done';
  /** Read from the terminal by the harness, not reported by the agent */
  guess?: boolean }
/** What the harness service knows about a session (`harness::Tracked`). */
export interface Tracked {
  name: string; profile: string; state: 'starting' | 'working' | 'idle' | 'waiting' | 'unknown' | 'exited';
  since: number; precise: boolean; agentSession: string | null; attention: Attention | null; lastMessage: string | null;
  /** When its last turn ended with `lastMessage` */
  lastMessageAt?: number;
  /** False when `name` is the title the agent gave the session, not a name someone chose */
  named?: boolean;
  /** What the agent says it is doing (its `set_status` tool) */
  status?: string;
  /** The part it plays, in its own words or the supervisor's */
  role?: string;
  /** The session it works for (id): that one gives it tasks and reads its results */
  supervisor?: string | null;
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
  /** What it registered that it waits for outside itself, oldest first */
  waits?: SessionWait[];
}
/** Something outside a session that it waits for (its `wait_register` tool). */
export interface SessionWait {
  id: string; kind: 'pipeline' | 'integration' | 'human' | 'peer' | 'timer' | 'other'; on: string; ref: string;
  since: number; expectBy: number; overdue: boolean;
  /** Who was told that it runs late */
  escalated: 'supervisor' | 'operator' | null;
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
  /** New Codex sessions are started with the harness's hooks (the person trusts them once in Codex) */
  codexHooks?: boolean;
  /** A Codex hook has reported under this program's path: Codex runs them, so the person trusted them. Remembered after the sessions are gone */
  codexHooksReporting?: boolean;
}

/** One of the app's two background processes, as found without starting it. */
export interface BackgroundUnit {
  name: 'runner' | 'harness service'; label: string; plist: string | null; installed: boolean;
  running: boolean; pid: number | null; since: string | null; version: string | null; exe: string | null;
}
/** `consent`: the person allowed the background processes, stopped them, or was never asked. */
export interface Background { consent: 'allowed' | 'stopped' | 'new'; units: BackgroundUnit[]; sessions: number }
/** The backend's answer while the background processes are not allowed (`runner::NOT_ALLOWED`). */
export const notAllowed = (e: unknown) => String(e instanceof Error ? e.message : e).includes('Background processes are not allowed');

/** What an agent told the person with its `report` tool. */
/** An executor in a status report, as the service knew it when the report was made. */
export interface ExecutorLine { session: string; name: string; state: string; needsOperator: boolean; waits: string[] }
export interface Report {
  id: string; session: string; name: string; cwd: string; text: string; created: number;
  /** `status` notifies nobody and marks nothing; the board holds the latest one of each session */
  kind: 'needs_human' | 'done' | 'status';
  /** The session it worked for when it reported (id) */
  supervisor?: string;
  /** On a status report of a supervising session */
  executors?: ExecutorLine[];
}
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

/** A report in its group: `depth` is the number of supervisors above its session inside the group. */
export interface ReportRow { report: Report; depth: number }
/**
 * The reports of one supervisor and of the sessions below it, or (`session`
 * empty) of the sessions that work for nobody and supervise nobody.
 */
export interface ReportGroup { session: string; name: string; live: boolean; rows: ReportRow[] }

/**
 * Reports by supervisor: a group per top session, with its own reports first
 * and then each executor's, and theirs, in the order of the tree. Inside a
 * session the status report comes first, then the rest, newest first. Who
 * works for whom is what the session list says now; for a session that ended
 * it is what its last report recorded. Groups with the newest report come
 * first; sessions outside any tree are one last group, newest report first.
 */
export function reportGroups(reports: Report[], hosted: Hosted[]): ReportGroup[] {
  const live = new Map(hosted.filter(h => !h.exit).map(h => [h.id, h]));
  const own = new Map<string, Report[]>();
  for (const r of reports) own.set(r.session, [...own.get(r.session) ?? [], r]);
  const above = (id: string) => live.has(id) ? live.get(id)!.harness?.supervisor || '' : [...own.get(id) ?? []].reverse().find(r => r.supervisor)?.supervisor ?? '';
  // Every session with a report, and the supervisors above them; a circle ends where it closes
  const up = new Map<string, string>();
  for (const id of own.keys()) {
    const path = new Set<string>();
    for (let at = id; at && !path.has(at) && !up.has(at); at = up.get(at)!) {
      path.add(at);
      const next = above(at);
      up.set(at, path.has(next) ? '' : next);
    }
  }
  const newest = (ids: string[]) => Math.max(0, ...ids.flatMap(id => (own.get(id) ?? []).map(r => r.created)));
  const name = (id: string) => {
    const h = hosted.find(x => x.id === id);
    return h && isSupervisor(h) ? 'Supervisor' : (own.get(id) ?? []).slice(-1)[0]?.name || (h ? hostedLabel(h) : '') || id;
  };
  const rows = (id: string, depth: number): ReportRow[] => {
    const mine = [...own.get(id) ?? []].reverse();
    const status = mine.find(r => r.kind === 'status');
    return [...status ? [status] : [], ...mine.filter(r => r !== status)].map(report => ({ report, depth }));
  };
  const below = (id: string) => [...up].filter(([, s]) => s === id).map(([child]) => child).sort((a, b) => name(a).localeCompare(name(b)) || a.localeCompare(b));
  const tree = (id: string, depth: number): ReportRow[] => [...rows(id, depth), ...below(id).flatMap(child => tree(child, depth + 1))];
  const members = (id: string): string[] => [id, ...below(id).flatMap(members)];
  const tops = [...up].filter(([, s]) => !s).map(([id]) => id);
  // A supervisor heads a group before any of its executors has reported
  const supervises = (id: string) => below(id).length > 0 || [...live.values()].some(h => h.id === id ? isSupervisor(h) : h.harness?.supervisor === id) || (own.get(id) ?? []).some(r => r.executors?.length);
  const groups = tops.filter(supervises)
    .map(id => ({ group: { session: id, name: name(id), live: live.has(id), rows: tree(id, 0) }, at: newest(members(id)) }))
    .sort((a, b) => b.at - a.at || a.group.session.localeCompare(b.group.session))
    .map(g => g.group);
  const alone = tops.filter(id => !supervises(id)).flatMap(id => own.get(id) ?? []).sort((a, b) => b.created - a.created);
  return alone.length ? [...groups, { session: '', name: '', live: false, rows: alone.map(report => ({ report, depth: 0 })) }] : groups;
}

/** The Slack connector as the harness service reports it (decision D14). No token is in it. */
export interface SlackConnection {
  team: string; url: string; botName: string; operator: string; operatorName: string; approveInSlack: boolean; connected: number;
  /** Permissions of the manifest that the bot lacks */
  missingScopes?: string[];
}
export type SlackListen = 'off' | 'mentions' | 'all';
export type SlackPosting = 'never' | 'approve' | 'thread' | 'auto';
export interface SlackChannel {
  id: string; name: string; private: boolean; member: boolean; listen: SlackListen; senders: string[];
  route: { kind: 'none' | 'session' | 'supervisor'; session: string }; posting: SlackPosting; posters: string[]; skipped: boolean;
  /** Why a message that arrives now would reach no session (its route names nobody who runs); the service's words */
  routeProblem?: string | null;
}
export type SlackPostState = 'waiting' | 'approved' | 'sending' | 'sent' | 'denied' | 'cancelled' | 'failed' | 'unknown';
export interface SlackPost {
  id: string; session: string; sessionName: string; channel: string; channelName: string; threadTs?: string | null; text: string;
  state: SlackPostState; created: number; decided: number; allowedBy: string; reason?: string | null; link?: string | null;
}
export interface SlackReceived {
  key: string; channel: string; channelName: string; user: string; userName: string; text: string; at: number;
  caughtUp: boolean; session?: string | null; held?: string | null;
  /** The text was longer than what the service keeps */
  cut?: boolean;
}
export interface SlackStatus {
  connection: SlackConnection | null; enabled: boolean; link: 'off' | 'connecting' | 'connected' | 'reconnecting' | 'refused'; linkError: string; lastEvent: number;
  /** When Slack last accepted the connection, and what arrived since the service started */
  connectedAt?: number; eventsSeen?: number; actionsSeen?: number;
  /** Frames of any kind from Slack, the kind of the last one, and the last event that was not kept (type and why, never its text) */
  envelopesSeen?: number; lastEnvelope?: string; lastDropped?: string;
  /** Slack asked to wait before giving these channels' history: their names and when they are read again */
  catchUpWait?: { until: number; channels: string[] } | null;
  /** Why the service could not write its Slack state; while set it sends and delivers nothing */
  storeError?: string | null;
  channels: SlackChannel[]; users: Record<string, string>; posts: SlackPost[]; received: SlackReceived[];
  audit: { at: number; kind: string; text: string }[];
  counts: { sentWithoutApproval: number; refusedApprovals: number; deliveredFromStrangers: number; held: number; waiting: number };
}
export type SlackPolicy = Partial<{ listen: SlackListen; posting: SlackPosting; route: 'none' | 'session' | 'supervisor'; session: string; senders: string[]; posters: string[] }>;
export const SLACK_POSTING: Record<SlackPosting, string> = {
  never: 'Never', approve: 'Ask me each time', thread: 'Thread replies at once, the rest asks', auto: 'At once, without asking',
};

export const slackApi = {
  status: () => invoke<SlackStatus>('slack_status'),
  /** Null when the person said no in the native dialog */
  connect: (bot: string, appToken: string, operator: string) => invoke<SlackStatus | null>('slack_connect', { bot, appToken, operator }),
  disconnect: () => invoke<SlackStatus>('slack_disconnect'),
  enable: (on: boolean) => invoke<SlackStatus>('slack_enable', { on }),
  approval: (on: boolean) => invoke<SlackStatus>('slack_approval', { on }),
  refresh: () => invoke<SlackStatus>('slack_refresh'),
  policy: (channel: string, policy: SlackPolicy) => invoke<SlackStatus>('slack_policy', { channel, policy }),
  decide: (post: string, approve: boolean, text?: string, reason?: string) => invoke<SlackStatus>('slack_decide', { post, approve, text: text ?? null, reason: reason || null }),
};

/** The memory server's connection (D16), as the service reports it. It never carries a token. */
export interface MemoryStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'signed_out';
  endpoint: string;
  issuer?: string | null;
  /** When it was connected, ms; 0 when it is not */
  since: number;
  /** The memory a call goes to when it names none */
  defaultMemory: string;
  /** The last thing that went wrong, in the service's words */
  problem?: { kind: string; text: string; at: number } | null;
}

/** One line on where the memory connection stands, for Settings. */
export function memoryStateLine(status: MemoryStatus): string {
  switch (status.state) {
    case 'connected': return `Connected to ${status.endpoint}. New and restarted sessions have the memory tools; a call that names no memory goes to ${status.defaultMemory}.`;
    case 'connecting': return 'Waiting for the sign-in in your browser. It is given up after five minutes.';
    case 'signed_out': return 'The sign-in is no longer valid. Sign in again; until then sessions are told that memory is not available.';
    default: return 'Not connected. Agent sessions have a memory server that tells them so.';
  }
}

export const memoryApi = {
  status: () => invoke<MemoryStatus>('memory_status'),
  /** Asks in a native dialog, then opens the browser; resolves to the status either way */
  connect: () => invoke<MemoryStatus>('memory_connect'),
  /** Asks in a native dialog unless a sign-in is only under way */
  disconnect: () => invoke<MemoryStatus>('memory_disconnect'),
};

export const harnessApi = {
  status: () => invoke<HarnessStatus>('harness_status'),
  preferences: () => invoke<HarnessPreferences>('harness_preferences'),
  savePreferences: async (preferences: Omit<HarnessPreferences, 'profiles'>) => {
    const result = await invoke<HarnessPreferences>('harness_preferences', { preferences });
    window.dispatchEvent(new Event(HARNESS_PREFERENCES_CHANGED));
    return result;
  },
  /** The background processes and the person's decision about them; starts nothing */
  background: () => invoke<Background>('harness_background'),
  /** Asks in a native dialog; resolves to whether they are allowed now */
  allowBackground: () => invoke<boolean>('harness_background_allow'),
  /** Ends every session and both processes after a native dialog; resolves to whether it was done */
  stopBackground: (uninstall: boolean) => invoke<boolean>('harness_background_stop', { uninstall }),
  list: () => invoke<{ sessions: Hosted[] }>('harness_list').then(r => r.sessions),
  /** `supervisor`: the session the new one works for, as its executor */
  spawn: (profile: string, cwd: string, cols: number, rows: number, resume?: string, supervisor?: string) => invoke<Hosted>('harness_spawn', { profile, cwd, cols, rows, resume, supervisor: supervisor ?? null }),
  /** Connect a session to a supervising one (asked in a native dialog; null when the person said no), or detach it */
  bind: (id: string, supervisor: string | null) => invoke<Hosted | null>('harness_bind', { id, supervisor }),
  /** The hosted supervisor session: the running one, or a new one */
  /** Asks in a native dialog before turning it on; resolves to the setting as it is now */
  outsideSupervisors: (on: boolean) => invoke<boolean>('harness_outside_supervisors', { on }),
  /** Asks in a native dialog before turning it on; resolves to the setting as it is afterwards */
  codexHooks: (on: boolean) => invoke<boolean>('harness_codex_hooks', { on }),
  supervisor: (cols: number, rows: number) => invoke<Hosted>('harness_supervisor', { cols, rows }),
  /** End the agent and continue its conversation in a new process; the session id changes */
  restart: (id: string) => invoke<Hosted & { replaced: string; resumed: boolean }>('harness_restart', { id }),
  resumable: () => invoke<{ sessions: Resumable[] }>('harness_resumable').then(r => r.sessions),
  /** What sessions reported to the person, and the live notes of the bulletin board */
  board: () => invoke<Board>('harness_board'),
  /** A note from the person; without a folder it is for every session */
  postNote: (text: string, hours: number, folder?: string) => invoke<void>('harness_note_post', { text, hours, folder: folder || null }),
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
  const folder = h.cwd.split('/').filter(Boolean).pop() ?? '';
  return !text || text === folder || HARNESS_NAME.test(text) ? '' : text;
}

export const isSupervisor = (h: Hosted) => h.meta.role === 'supervisor';

export function hostedLabel(h: Hosted, titles: Record<string, string> = {}): string {
  const name = h.harness?.name?.trim() ?? '';
  const named = h.harness?.named ? name : '';
  const meaningfulName = HARNESS_NAME.test(name) || /^[0-9a-f-]{8,}$/i.test(name) ? '' : name;
  return named || h.meta.name || meaningfulName || h.harness?.role?.trim() || titles[h.harness?.agentSession ?? ''] || titleName(h) || h.meta.label || h.argv[h.argv.length - 1]?.replace(/^exec /, '') || h.id;
}

/** Display name shown in the Live sidebar (and command panel) for a hosted session. */
export function liveSessionLabel(h: Hosted, titles: Record<string, string> = {}): string {
  return isSupervisor(h) ? 'Supervisor' : hostedLabel(h, titles);
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


/** The drag type of a session row; its text/plain data is the session's reference. */
export const SESSION_DRAG_TYPE = 'application/x-mcr-session';

/**
 * A pointer to a session, to paste or drop into another one: `mcr:<id>` is
 * what the mcr tools take as `to` (hosted agents are told so, `PEER_NOTE`);
 * the name after it is for the reader. The name can be set by an agent (a
 * terminal title, a name the supervisor chose) and the pointer may be dropped
 * into a shell: it goes in single quotes, without anything a shell would
 * expand or that would end the quotes or the line.
 */
export function sessionReference(h: Hosted, titles: Record<string, string> = {}): string {
  const name = hostedLabel(h, titles).replace(/[\u0000-\u001f\u007f-\u009f'"`$\\]/g, '').trim();
  return `mcr:${h.id} '${name}'`;
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

/** The first thing a message says, as one plain line: no Markdown marks, at most `max` characters. */
export function gist(message: string, max = 220): string {
  const line = message.split('\n').map(l => l.trim()).find(l => l && !/^(```|---|\|[-\s|:]+\|?$)/.test(l)) ?? '';
  const plain = line.replace(/^(#{1,6}|[-*+]|\d+[.)]|>)\s+/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|`)/g, '').trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/**
 * What a live session is doing, or what it finished with, for its row.
 * `lead` says since when; `text` is the agent's own status while it works,
 * and when its turn has ended, how its last message begins (its status when
 * it left no message). `full` is the whole of both, for a tooltip.
 */
export function sessionSummary(h: Hosted, now: number): { lead: string; text: string; full: string } | null {
  const t = h.harness;
  if (h.exit || !t) return null;
  const status = t.status?.trim() ?? '';
  const last = t.lastMessage?.trim() ?? '';
  const full = [status && `Status: ${status}`, last && `Last message:\n${last}`].filter(Boolean).join('\n\n');
  if (t.state === 'working') return { lead: `Working ${runningFor(t.since, now)}`, text: status, full };
  if (t.state === 'idle' || t.state === 'waiting') {
    const ended = t.lastMessageAt || t.since;
    const text = gist(last) || status;
    if (!text) return null;
    return { lead: last ? `Done ${runningFor(ended, now)} ago` : `Idle ${runningFor(ended, now)}`, text, full };
  }
  return status ? { lead: '', text: status, full } : null;
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
/** A session's place among supervisors and executors, inside one folder's list. */
export interface RelationRow {
  session: Hosted;
  /** Levels of supervisor above it that are shown in the same folder */
  depth: number;
  /** Live sessions that work for it, in any folder */
  executors: number;
  /** Its supervisor, when that one is listed in another folder */
  elsewhere?: Hosted;
}

/**
 * The sessions of one folder in tree order: each supervisor followed by its
 * executors, and theirs. A session whose supervisor sits in another folder
 * stays at the top level here and names it. `all` is every hosted session.
 */
export function relationRows(inFolder: Hosted[], all: Hosted[]): RelationRow[] {
  const here = new Set(inFolder.map(h => h.id));
  const above = (h: Hosted) => h.harness?.supervisor || '';
  const count = (id: string) => all.filter(h => !h.exit && above(h) === id).length;
  const out: RelationRow[] = [];
  const seen = new Set<string>();
  const add = (h: Hosted, depth: number) => {
    if (seen.has(h.id)) return;
    seen.add(h.id);
    const up = above(h);
    out.push({ session: h, depth, executors: count(h.id), elsewhere: up && !here.has(up) ? all.find(x => x.id === up) : undefined });
    inFolder.filter(c => above(c) === h.id).forEach(c => add(c, depth + 1));
  };
  inFolder.filter(h => !here.has(above(h))).forEach(h => add(h, 0));
  // Never lose a row to a relation that makes no sense
  inFolder.forEach(h => add(h, 0));
  return out;
}

/**
 * The sessions offered as supervisor for `session`, in the order of the
 * chooser: those in its own folder first, then the others; each group by the
 * title shown, A to Z without regard to case, then by folder, then by id.
 */
export function supervisorChoices(session: Hosted, candidates: Hosted[]): { here: Hosted[]; elsewhere: Hosted[] } {
  const title = (h: Hosted) => hostedLabel(h).toLowerCase();
  const order = (a: Hosted, b: Hosted) => title(a).localeCompare(title(b)) || a.cwd.localeCompare(b.cwd) || a.id.localeCompare(b.id);
  const sorted = [...candidates].sort(order);
  return { here: sorted.filter(h => h.cwd === session.cwd), elsewhere: sorted.filter(h => h.cwd !== session.cwd) };
}

/** The sessions below one: its executors and theirs (ids). */
export function executorsBelow(id: string, all: Hosted[]): Set<string> {
  const below = new Set<string>();
  const walk = (up: string) => all.filter(h => h.harness?.supervisor === up && !below.has(h.id)).forEach(h => { below.add(h.id); walk(h.id); });
  walk(id);
  return below;
}

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
  const parts = path.split('/');
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path;
}

/** A path with the home folder written as ~. */
export const tildePath = (path: string, home: string) => home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
