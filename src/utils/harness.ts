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
export interface Attention { kind: 'permission' | 'assessment' | 'notification'; text: string; since: number; report?: 'needs_human' | 'done';
  /** Read from the terminal by the harness, not reported by the agent */
  guess?: boolean }
/** What the harness service knows about a session (`harness::Tracked`). */
export interface Tracked {
  name: string; profile: string; state: 'starting' | 'working' | 'idle' | 'waiting' | 'unknown' | 'exited';
  since: number; precise: boolean; agentSession: string | null;
  /** The agent has reported through a hook: with `precise`, the state is the hooks' word */
  hooked?: boolean; attention: Attention | null; lastMessage: string | null;
  /** When its last turn ended with `lastMessage` */
  lastMessageAt?: number;
  /** False when `name` is the title the agent gave the session, not a name someone chose */
  named?: boolean;
  /** What the agent says it is doing (its `set_status` tool) */
  status?: string;
  /** The part it plays, in its own words or the supervisor's */
  role?: string;
  /** The person has an unsent line in its input box: notices and tasks wait (MCR-85) */
  draft?: boolean;
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
/** One OSC 7501 record a program keeps in its terminal (`program::Record`): exactly its last report with that id. */
export interface ProgramRecord {
  /** Absent for the root record */
  id?: string;
  state: 'idle' | 'working' | 'done' | 'blocked' | 'error';
  kind?: 'permission' | 'question' | 'auth'; progress?: number; app?: string; title?: string; msg?: string; at: number;
}
/** What the program in a terminal said of itself (`program::Program`, MCR-115). Untrusted: any output can print it. */
export interface ProgramStatus {
  /** Least recently updated first */
  records?: ProgramRecord[];
  /** The last OSC 133 mark: A a prompt starts, B input, C a command runs, D it finished */
  prompt?: { mark: 'A' | 'B' | 'C' | 'D'; exit?: number; at: number };
  /** The last OSC 9;4 progress */
  progress?: { state: 'normal' | 'error' | 'indeterminate' | 'paused'; value?: number; at: number };
}
/** A terminal the runner hosts (`runner::Info`), with the service's view of it. */
export interface Hosted {
  id: string; pid: number | null; argv: string[]; cwd: string; started: number;
  cols: number; rows: number; title: string; lastOutput?: number;
  exit: HostedExit | null; meta: Record<string, string>;
  /** What the program said of itself in its output (absent from a runner older than MCR-115) */
  program?: ProgramStatus;
  /** From the service: the session ended and its folder is no longer on disk (MCR-107) */
  cwdGone?: boolean;
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

/** How long an ended session stays in Live without an open report. */
export const ENDED_ROW_GRACE_MS = 0;

export function showHostedRow(h: Hosted, now: number, graceMs = ENDED_ROW_GRACE_MS): boolean {
  return !h.exit || !!h.harness?.attention?.report || (graceMs > 0 && now - h.exit.at < graceMs);
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
  /** From the service: its folder is no longer on disk (MCR-107) */
  gone?: boolean;
}
/** An agent profile the app may start a session from (MCR-126): the service loads and checks it again */
export interface AgentProfileChoice { id: string; version: number; role: string; adapter: string; summary: string; model?: string | null; effort?: string | null; mode?: string | null }

/** The tooltip of a profile in a start menu: what it is and how it runs */
export function agentProfileTitle(p: AgentProfileChoice): string {
  const how = [p.model && `model ${p.model}`, p.effort && `effort ${p.effort}`, p.mode && `mode ${p.mode}`].filter(Boolean).join(', ');
  return `${p.summary || p.id} (v${p.version}${how ? `; ${how}` : ''})`;
}

export interface HarnessStatus {
  runner: { protocol: number; pid: number; version: string; exe: string }; profiles: Profile[]; home: string;
  /** Agent profiles for the start menu; absent from an older build */
  agentProfiles?: AgentProfileChoice[];
  supervisorProfile?: string | null;
  /** Run once in a terminal to give an outside agent the supervisor tools */
  supervisorCommand?: string;
  /** The operator lets agents outside the harness use the supervisor tools */
  outsideSupervisors?: boolean;
  /** New Codex sessions are started with the harness's hooks (the person trusts them once in Codex) */
  codexHooks?: boolean;
  /** A Codex hook has reported under this program's path: Codex runs them, so the person trusted them. Remembered after the sessions are gone */
  codexHooksReporting?: boolean;
  /** The service answers a program's OSC 7501 feature query (MCR-115; off by default) */
  programQuery?: boolean;
  /** What the service could not read of its state file at its last start, until the person has seen it */
  storeNotice?: StoreNotice | null;
}

/** The service's word about a state file it could not read whole (MCR-99). Part names and ids only, never stored text. */
export interface StoreNotice {
  at: number; kind: 'unread' | 'partial';
  /** Where the file is kept as it was found; empty when it could not be kept */
  kept: string; lost: string[]; why: string;
  /** The file could not be kept aside, so the service saves nothing in this run */
  frozen: boolean;
}

/** What the Live view says for a notice: what happened, then where the file is. */
export function storeNoticeLines(n: StoreNotice): { what: string; kept: string } {
  const what = n.kind === 'unread'
    ? `The harness service could not read its state file${n.why ? ` (${n.why})` : ''} and started with an empty store: relations, messages, tasks, reports and notes from before are not loaded.`
    : `The harness service left out what it could not read of its state file: ${n.lost.join('; ')}. The rest is loaded.`;
  const kept = n.frozen
    ? 'The file is left as it is and the service saves nothing until it is restarted: make the file readable and its folder writable first.'
    : `The file as it was found is kept at ${n.kept}. To use it again, stop the background processes, put it back as harness-state.json (repaired, or with a build that reads it) and start them again: what was stored since is then replaced.`;
  return { what, kept };
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

/**
 * The cockpit (MCR-94, MCR-95): what sessions published for the person, joined by the
 * service with what it knows itself. Everything a session wrote is text to show, never to run:
 * `say`, `where.command` and `where.url` are strings, and a click must check them again.
 */
export type TrackState = 'moving' | 'waiting_human' | 'blocked' | 'parked' | 'done';
export type ItemState = 'doing' | 'review' | 'ready' | 'waiting' | 'done';
export interface CockpitWaitsOn {
  kind: 'human' | 'session' | 'ci' | 'timer' | 'external';
  /** With kind `session`: its id */
  who?: string; what?: string; since?: number;
  /** Set when the service took it from a wait the owner registered, not from published text */
  derived?: 'wait'; wait?: string; ref?: string; overdue?: boolean;
}
export interface CockpitItem {
  id: string; title: string; ref?: string;
  /** A session id, or `human` */
  owner: string; state: ItemState; waitsOn?: CockpitWaitsOn; next?: string;
}
export interface CockpitTrack {
  id: string; title: string;
  /** Session id */
  lead: string; refs?: string[]; state: TrackState; line?: string; items?: CockpitItem[]; updated?: number;
  /** The session that published it; `supervisor` for the root Supervisor */
  by: string;
  /** From the service, never published: the operator pressed Enter in its lead's terminal at this time, after it was last published as waiting for them (MCR-103) */
  ownerTyped?: number;
}
/** `answer_prompt` and `report` come from the service only (`derived`); sessions publish the others. */
/** `question`: a need asked with `report` that has no choices (MCR-124), in its older action form */
export type CockpitActionKind = 'typed_word' | 'decision' | 'secret_step' | 'live_check' | 'external' | 'question' | 'answer_prompt' | 'report' | 'held_line' | 'human_wait';
export interface CockpitAction {
  id: string; title: string; kind: CockpitActionKind;
  track?: string; trackBy?: string; item?: string;
  where?: { session?: string; url?: string; command?: string };
  /** `typed_word`: the line for that session's input box, to be placed unsent */
  say?: string; options?: string[]; recommended?: string; why?: string; blocks?: string[];
  /** Absent on derived actions */
  risk?: 'reversible' | 'irreversible' | 'spend'; amount?: string;
  urgency?: 'now' | 'today' | 'whenever';
  source?: string[]; detail?: string; since?: number; updated?: number;
  by?: string;
  /** Built by the service: a session's prompt, its open needs_human report, the operator's unsent line there, a human wait past its time (MCR-118) */
  derived?: 'prompt' | 'report' | 'held' | 'wait';
  /** Its track was removed since */
  trackMissing?: boolean;
  /** From the service, never published: the operator pressed Enter in `where.session` at this time, after the action was last published (MCR-103) */
  ownerTyped?: number;
  /** From the service: `where.session` has ended or is gone */
  sessionEnded?: boolean;
  /** From the service: which of its texts a click would refuse (stored under an earlier rule). Shown as text, no button */
  unclickable?: ('say' | 'options' | 'url' | 'command')[];
  /** The action form of a need asked with `report` (MCR-124): a click names the need, and the service resolves it */
  need?: boolean;
  /**
   * From the service, never published. `reportOpen`: it names a report in
   * `source`, and whether that report is still open. The rest is what the
   * harness knows of the session it points at, merged into it instead of a
   * derived row of its own (MCR-118)
   */
  live?: CockpitLive;
}
/** What the harness knows of the session a published action points at (`Cockpit::read`). */
export interface CockpitLive {
  reportOpen?: boolean;
  /** At a prompt since */
  prompt?: number;
  /** The operator's unsent line there, since */
  held?: number;
  /** Its open needs_human report */
  report?: { id: string; since: number; text: string };
  /** Its human waits past their time */
  waits?: { id: string; on: string; ref?: string; since: number }[];
}
/** A link as the service's parser reads it: what the question shows and what is opened (MCR-97). */
export interface CockpitLink { href: string; host: string; path: string; query: string; known: boolean }
/** What a click in the cockpit asks for. `open` opens the link the service names for that action. */
export type CockpitAct = 'place' | 'choose' | 'ask' | 'link' | 'open' | 'copy';
export interface CockpitActed { placed?: string; link?: CockpitLink; opened?: string; copied?: boolean }

/** What the service knows of a session the cockpit names. The details only where the reader may see them. */
export interface CockpitSession {
  name?: string; state?: string; ended?: boolean;
  /** No such session any more */
  gone?: boolean;
  needsOperator?: boolean; doneReport?: string | null;
  waits?: { id: string; kind: string; on: string; ref: string; since: number; overdue: boolean }[];
}
export interface Cockpit {
  schema: number;
  /** One up per accepted change: unchanged means nothing was published since */
  version: number; updated: number;
  tracks: CockpitTrack[]; actions: CockpitAction[]; sessions: Record<string, CockpitSession>;
}

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
    const kind = h.harness?.attention?.report;
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
  waiting: () => invoke<number>('slack_waiting'),
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
  listSince: (stamp: string) => invoke<{ stamp: string; sessions: Hosted[] | null }>('harness_list_since', { stamp: stamp || null }),
  /** `supervisor`: the session the new one works for, as its executor */
  spawn: (profile: string, cwd: string, cols: number, rows: number, resume?: string, supervisor?: string) => invoke<Hosted>('harness_spawn', { profile, cwd, cols, rows, resume, supervisor: supervisor ?? null }),
  /** Connect a session to a supervising one (asked in a native dialog; null when the person said no), or detach it */
  bind: (id: string, supervisor: string | null) => invoke<Hosted | null>('harness_bind', { id, supervisor }),
  /** The hosted supervisor session: the running one, or a new one */
  /** The person has read the notice; resolves to the notice as it is afterwards (one the service still has to say stays) */
  storeNoticeSeen: () => invoke<StoreNotice | null>('harness_store_notice_seen'),
  /** Asks in a native dialog before turning it on; resolves to the setting as it is now */
  outsideSupervisors: (on: boolean) => invoke<boolean>('harness_outside_supervisors', { on }),
  /** Asks in a native dialog before turning it on; resolves to the setting as it is afterwards */
  codexHooks: (on: boolean) => invoke<boolean>('harness_codex_hooks', { on }),
  /** Asks in a native dialog before turning it on; resolves to the setting as it is afterwards */
  programQuery: (on: boolean) => invoke<boolean>('harness_program_query', { on }),
  supervisor: (cols: number, rows: number) => invoke<Hosted>('harness_supervisor', { cols, rows }),
  /** End the agent and continue its conversation in a new process; the session id changes */
  restart: (id: string) => invoke<Hosted & { replaced: string; resumed: boolean }>('harness_restart', { id }),
  resumable: () => invoke<{ sessions: Resumable[] }>('harness_resumable').then(r => r.sessions),
  /** What sessions reported to the person, and the live notes of the bulletin board */
  board: () => invoke<Board>('harness_board'),
  /** The cockpit: published tracks and actions with the service's own facts; `CockpitPanel` shows it over the Supervisor's terminal */
  cockpit: () => invoke<Cockpit>('harness_cockpit'),
  /**
   * A click in the cockpit (MCR-97). Ids only: the part, the action, the stamp
   * the panel showed, and for `choose` the option's place in the list. No text,
   * session, link or command is ever sent from the page; the service takes them from its store.
   */
  cockpitAct: (by: string, id: string, updated: number, act: CockpitAct, option?: number) => invoke<CockpitActed>('harness_cockpit_act', { by, id, updated, act, option: option ?? null }),
  /** Copy as task (MCR-125 v0): the instruction and the excerpt as one task text on the clipboard. Starts and stores nothing */
  copyAsTask: (source: string, instruction: string, excerpt: string) => invoke<void>('harness_copy_as_task', { source, instruction, excerpt }),
  /** The operator's copy of a terminal selection, through the platform's clipboard tool */
  copyText: (text: string) => invoke<void>('harness_copy_text', { text }),
  /** A note from the person; without a folder it is for every session */
  postNote: (text: string, hours: number, folder?: string) => invoke<void>('harness_note_post', { text, hours, folder: folder || null }),
  removeNote: (note: string) => invoke<void>('harness_note_remove', { note }),
  /** The person looked at a session's notification */
  ack: (id: string, since?: number) => invoke<void>('harness_ack', { id, since }),
  signal: (id: string, signal: 'INT' | 'TERM' | 'HUP' | 'KILL') => invoke<void>('harness_signal', { id, signal }),
  forget: (id: string) => invoke<void>('harness_forget', { id }),
  resize: (id: string, cols: number, rows: number) => invoke<void>('terminal_resize', { id, cols, rows }),
  /**
   * A view of a session's output. `start` comes first, with the offset of the
   * first byte in all the session's output (null: the runner does not say);
   * with `since` the runner starts there when it still holds it. Then raw
   * bytes; an empty buffer means the stream ended.
   */
  attach: (id: string, since: number | null, on: { start: (from: number | null) => void; data: (bytes: Uint8Array) => void }) => {
    const output = new Channel<ArrayBuffer>();
    output.onmessage = data => { const from = frameStart(data); if (from !== undefined) on.start(from); else on.data(unframe(data)); };
    return invoke<number>('terminal_attach', { id, since, output });
  },
  input: (view: number, data: string) => invoke<void>('terminal_input', { view, data }),
  clearDraft: (id: string, since: number) => invoke<void>('harness_clear_draft', { id, since }),
  detach: (view: number) => invoke<void>('terminal_detach', { view }),
  saveImage: (id: string, bytes: ArrayBuffer) => invoke<string>('terminal_save_image', bytes, { headers: { session: id } }),
};

/**
 * The bytes of one frame of terminal output (`frame` in harness_commands.rs):
 * a little-endian u32 length, the bytes, zeros up to 1024. Frames are never
 * shorter, so Tauri fetches them as bytes instead of sending them as source
 * text the web view compiles (MCR-139). Length 0 is the end of the stream.
 * The first frame of a view says where its bytes start: the length u32::MAX,
 * then that offset (u64; u64::MAX when the runner does not say).
 */
export function frameStart(data: ArrayBuffer): number | null | undefined {
  if (data.byteLength < 12) return undefined;
  const view = new DataView(data);
  if (view.getUint32(0, true) !== 0xffffffff) return undefined;
  const from = view.getBigUint64(4, true);
  return from > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(from);
}

/** The bytes of a data frame (see `frameStart` for the first frame of a view). */
export function unframe(data: ArrayBuffer): Uint8Array {
  if (data.byteLength < 4) return new Uint8Array(0);
  const length = new DataView(data).getUint32(0, true);
  return new Uint8Array(data, 4, Math.min(length, data.byteLength - 4));
}

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


/**
 * The session pointers in a line of terminal text: `mcr:` and a session id,
 * for the ids `known` says are sessions. `start` and `end` are indexes into
 * `text` (`end` is past the last character). A bare id is not a pointer: only
 * the `mcr:` form is, so other hex strings stay plain text.
 */
export function sessionLinks(text: string, known: (id: string) => boolean): { start: number; end: number; id: string }[] {
  const found: { start: number; end: number; id: string }[] = [];
  for (const m of text.matchAll(/(?<![\w:-])mcr:([0-9a-f]{12})(?![0-9a-f])/g)) {
    if (known(m[1])) found.push({ start: m.index, end: m.index + m[0].length, id: m[1] });
  }
  return found;
}

/** One terminal cell as xterm has it: its characters, and how many columns it takes (0: the second half of a wide character). */
export interface TerminalCell { chars: string; width: number }

/** Where a session pointer stands on screen: per row of the line it is on, the first column and how many columns it covers. */
export interface PointerSpan {
  id: string; text: string;
  /** Rows counted from the line's first row; columns from 0 */
  cells: { row: number; x: number; width: number }[];
}

/**
 * The session pointers in one line of terminal output, which may run over
 * several rows when the terminal wrapped it (MCR-106: a pointer cut by the
 * wrap is still one pointer). `rows` are the line's rows in order, each as
 * its cells. An empty cell counts as a space.
 */
export function pointerSpans(rows: TerminalCell[][], known: (id: string) => boolean): PointerSpan[] {
  let text = '';
  // Where each character of `text` stands
  const at: { row: number; x: number; width: number }[] = [];
  rows.forEach((cells, row) => cells.forEach((cell, x) => {
    if (cell.width === 0) return;
    const chars = cell.chars || ' ';
    for (let i = 0; i < chars.length; i++) at.push({ row, x, width: cell.width });
    text += chars;
  }));
  return sessionLinks(text, known).map(link => {
    const cells: PointerSpan['cells'] = [];
    for (const c of at.slice(link.start, link.end)) {
      const last = cells[cells.length - 1];
      if (last && last.row === c.row) {
        if (c.x >= last.x + last.width) last.width = c.x + c.width - last.x;
      } else cells.push({ row: c.row, x: c.x, width: c.width });
    }
    return { id: link.id, text: text.slice(link.start, link.end), cells };
  });
}

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
  // A missing start time says nothing, not "NaNh NaNm"
  if (!Number.isFinite(now - started)) return '';
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

/** A path with one separator, none at the end but the root's. */
const normPath = (x: string) => x.replace(/\\/g, '/').replace(/(?<=[^/:])\/+$/, '');

/**
 * The rest of `path` below `folder` with `/` between its parts, or '' when it
 * is not inside it (the same folder is not inside). Told by whole folder
 * names: `/a/teob-ai` is not inside `/a/teob`.
 */
export function pathBelow(path: string, folder: string): string {
  const p = normPath(path), f = normPath(folder);
  const base = f.endsWith('/') ? f : `${f}/`;
  return f && p !== f && p.startsWith(base) ? p.slice(base.length).replace(/^\/+/, '') : '';
}

/**
 * The tag of a row listed in a section above its own folder (MCR-133): the last
 * folder of the rest of its path, and the whole path for the tooltip. Null when
 * the row is in the section's own folder.
 */
export function subfolderTag(sectionPath: string, cwd: string): { tag: string; path: string } | null {
  const rest = pathBelow(cwd, sectionPath);
  if (!rest) return null;
  const parts = rest.split('/').filter(Boolean);
  return { tag: parts[parts.length - 1] ?? rest, path: cwd };
}

/**
 * The folder whose section lists each session (MCR-133). A session that works
 * for another one and whose folder lies inside that one's folder (an executor
 * in a worktree below its lead) is listed in its supervisor's section, at any
 * depth; every other session in its own folder. The root Supervisor's
 * executors are never moved: it has no section.
 */
export function sectionFolders(sessions: Hosted[]): Map<string, string> {
  const byId = new Map(sessions.map(h => [h.id, h]));
  const out = new Map<string, string>();
  // In its supervisor's folder or below it: it goes where its supervisor is listed
  const within = (path: string, folder: string) => normPath(path) === normPath(folder) || !!pathBelow(path, folder);
  const home = (h: Hosted, seen: Set<string>): string => {
    const known = out.get(h.id);
    if (known !== undefined) return known;
    const up = byId.get(h.harness?.supervisor || '');
    // A circle of relations keeps every session in its own folder
    const folder = up && !isSupervisor(up) && !seen.has(up.id) && within(h.cwd, up.cwd) ? home(up, new Set(seen).add(h.id)) : h.cwd;
    out.set(h.id, folder);
    return folder;
  };
  sessions.forEach(h => home(h, new Set([h.id])));
  return out;
}

/**
 * The Live list by folder, in an order that does not move while work goes on:
 * folders with at least one running session first, then the rest, each group
 * sorted by path. A session that starts waiting changes its row, not its place.
 * An executor inside its supervisor's folder is listed in that one's section
 * (`sectionFolders`), and an earlier conversation from a folder inside a
 * section that lists sessions or was added by the person goes to the nearest
 * such section: a worktree gets a section only for a session that is not such
 * an executor (MCR-133).
 */
export function directorySections(sessions: Hosted[], resumable: Resumable[], pinned: string[], folders = sectionFolders(sessions)): DirSection[] {
  const by = new Map<string, DirSection>();
  const at = (path: string) => {
    let section = by.get(path);
    if (!section) { section = { path, sessions: [], earlier: [], pinned: pinned.includes(path), latest: 0 }; by.set(path, section); }
    return section;
  };
  pinned.forEach(at);
  for (const h of sessions) { const d = at(folders.get(h.id) ?? h.cwd); d.sessions.push(h); d.latest = Math.max(d.latest, h.started); }
  // Only a section that something else lists takes in the history of the folders below it, the nearest first:
  // a folder with nothing but history never gathers another's
  const listed = [...by.keys()].sort((a, b) => b.length - a.length);
  const into = (cwd: string) => by.has(cwd) ? cwd : listed.find(path => pathBelow(cwd, path)) ?? cwd;
  for (const r of resumable) { const d = at(into(r.cwd)); d.earlier.push(r); d.latest = Math.max(d.latest, r.modified); }
  const active = (d: DirSection) => d.sessions.some(h => !h.exit);
  return [...by.values()].map(d => ({ ...d, earlier: [...d.earlier].sort((a, b) => b.modified - a.modified) }))
    .sort((a, b) => Number(active(b)) - Number(active(a)) || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
}

/** What the person chose to see of the Live list (MCR-107). Kept in the app's settings, not in the harness. */
export interface LiveListPrefs {
  /** Folders the person hid, by exact path */
  hiddenFolders: string[];
  /** Folders the automatic rule would leave out and the person showed again */
  shownFolders: string[];
  /** Earlier (past) sessions the person hid, by conversation id */
  hiddenSessions: string[];
  /** Leave out folders that are gone and agents' temporary folders */
  hideNoise: boolean;
}
export const DEFAULT_LIVE_LIST: LiveListPrefs = { hiddenFolders: [], shownFolders: [], hiddenSessions: [], hideNoise: true };

/**
 * An agent's temporary folder: under the system's temp folder (scratchpads,
 * test homes made there) or a `.claude/live-check` test home. Told from the
 * path alone, on macOS, Linux and Windows.
 */
export function temporaryFolder(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)\.claude\/live-check(\/|$)/.test(p)) return true;
  return ['/tmp/', '/private/tmp/', '/var/tmp/', '/var/folders/', '/private/var/folders/'].some(root => `${p}/`.startsWith(root))
    || /^[a-z]:\/users\/[^/]+\/appdata\/local\/temp(\/|$)/.test(p)
    || /^[a-z]:\/windows\/temp(\/|$)/.test(p);
}

/** Why a folder is in the hidden entry. */
export type HiddenReason = 'hidden' | 'gone' | 'temporary' | 'sessions hidden';
export const HIDDEN_REASON: Record<HiddenReason, string> = { hidden: 'hidden by you', gone: 'folder gone', temporary: 'temporary', 'sessions hidden': 'its sessions hidden' };

/** A folder as the list shows it: its earlier sessions without the hidden ones, and how many those are. */
export interface ShownSection extends DirSection { hiddenEarlier: number }

/**
 * Which folders the Live list shows and which go into "Hidden folders", with
 * the reason. A folder with a running session or an open report always shows.
 * Hiding changes what is shown only: no session ends and no transcript is touched.
 */
export function folderVisibility(sections: DirSection[], prefs: LiveListPrefs): { shown: ShownSection[]; hidden: { section: ShownSection; reason: HiddenReason }[] } {
  const hiddenSessions = new Set(prefs.hiddenSessions);
  const shown: ShownSection[] = [];
  const hidden: { section: ShownSection; reason: HiddenReason }[] = [];
  for (const d of sections) {
    const earlier = d.earlier.filter(r => !hiddenSessions.has(r.id));
    const section: ShownSection = { ...d, earlier, hiddenEarlier: d.earlier.length - earlier.length };
    const reason = ((): HiddenReason | null => {
      if (d.sessions.some(h => !h.exit || h.harness?.attention?.report)) return null;
      if (prefs.hiddenFolders.includes(d.path)) return 'hidden';
      // Added by the person, or shown again by them: the automatic rule is theirs to overrule
      if (prefs.hideNoise && !d.pinned && !prefs.shownFolders.includes(d.path)) {
        // Only what lies in the folder itself: a gone worktree listed here (MCR-133) says nothing of this folder
        if (d.sessions.some(h => h.cwdGone && h.cwd === d.path) || d.earlier.some(r => r.gone && r.cwd === d.path)) return 'gone';
        if (temporaryFolder(d.path)) return 'temporary';
      }
      if (!d.pinned && !d.sessions.length && !earlier.length && section.hiddenEarlier) return 'sessions hidden';
      return null;
    })();
    if (reason) hidden.push({ section, reason }); else shown.push(section);
  }
  hidden.sort((a, b) => b.section.latest - a.section.latest);
  return { shown, hidden };
}

/** A path for a section heading: the last two folders, since the start is the same everywhere. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/);
  const separator = path.includes('\\') ? '\\' : '/';
  return parts.length > 3 ? `…${separator}${parts.slice(-2).join(separator)}` : path;
}

/** Why a session's messages or tasks are not typed into it yet: the person has
 * a line there that is not sent, and the harness keeps out of it (MCR-85). */
export function heldNote(h: Hosted): string {
  return h.harness?.draft && !h.exit && (h.unread || h.openTasks) ? 'held: you have an unsent line here' : '';
}

/** A program's word about itself, as the Live row shows it (MCR-115). */
export interface ProgramHint {
  /** Who says it: "program" with the program's own `app` name, which is its claim (a forged `app=Supervisor` must read as a program's word), or "shell" for an OSC 133 mark */
  lead: string;
  text: string;
  /** The tooltip: where it comes from, that it is unchecked, every record */
  full: string;
  /** 0 to 100 while a percent was reported */
  progress?: number;
  /** The hooks say otherwise; theirs is the state the row shows */
  disagrees: boolean;
}

const PROGRAM_SOURCE = 'Reported by the program in this terminal (OSC 7501, 133 or 9;4). Not checked: any output can print this, a file shown in the terminal too. It never answers a prompt and never changes the session\'s state.';

const recordWords = (r: ProgramRecord) => {
  const state = r.state === 'blocked' ? `blocked${r.kind ? ` (${r.kind})` : ''}` : r.state;
  return [`${state}${r.progress !== undefined ? ` ${r.progress}%` : ''}`, r.title, r.msg].filter(Boolean).join(' · ');
};

/**
 * What the program in a running session said of itself, ranked below what
 * the harness knows: the root record, else the record updated last; else
 * OSC 9;4 progress; else the last OSC 133 mark. The row's state dot and
 * state stay the hooks'; when they disagree the hint says so. Null when the
 * program said nothing or the session ended.
 */
export function programHint(h: Hosted): ProgramHint | null {
  const p = h.program;
  if (!p || h.exit) return null;
  const records = p.records ?? [];
  const fromHooks = !!(h.harness?.precise && h.harness?.hooked);
  const hooks = fromHooks ? `The agent's hooks say ${STATE_LABEL[hostedState(h)].toLowerCase()}, and the hooks rank first.` : '';
  const main = records.find(r => !r.id) ?? records[records.length - 1];
  if (main) {
    const more = records.length - 1;
    const lines = records.slice().reverse().map(r => `${r.id || '(root)'}: ${recordWords(r)} · ${formatAgo(r.at)}`);
    const disagrees = fromHooks && disagreement(main.state, hostedState(h));
    return {
      lead: ['program', main.app || records.find(r => r.app)?.app].filter(Boolean).join(' '),
      text: `${recordWords(main)}${more > 0 ? ` · +${more} more` : ''}`,
      full: [PROGRAM_SOURCE, hooks, ...lines].filter(Boolean).join('\n'),
      progress: main.state === 'working' || main.state === 'blocked' ? main.progress : undefined,
      disagrees,
    };
  }
  if (p.progress) {
    const g = p.progress;
    const text = g.state === 'indeterminate' ? 'busy' : `${g.state === 'normal' ? 'progress' : g.state}${g.value !== undefined ? ` ${g.value}%` : ''}`;
    return { lead: 'program', text, full: [PROGRAM_SOURCE, hooks, `OSC 9;4 · ${formatAgo(g.at)}`].filter(Boolean).join('\n'), progress: g.state === 'indeterminate' ? undefined : g.value, disagrees: false };
  }
  if (p.prompt) {
    const m = p.prompt;
    const text = m.mark === 'C' ? 'a command runs' : m.mark === 'D' ? `command finished${m.exit !== undefined ? ` with ${m.exit}` : ''}` : 'at a prompt';
    return { lead: 'shell', text, full: [PROGRAM_SOURCE, hooks, `OSC 133 ${m.mark} · ${formatAgo(m.at)}`].filter(Boolean).join('\n'), disagrees: false };
  }
  return null;
}

/** A program's state that contradicts the hooks' (asks while they say it works, works while they say it waits). */
function disagreement(program: ProgramRecord['state'], hooks: string): boolean {
  if (program === 'blocked') return hooks !== 'waiting';
  if (program === 'working') return hooks === 'idle' || hooks === 'waiting';
  if (program === 'idle') return hooks === 'working' || hooks === 'waiting';
  return false;
}

const formatAgo = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};
