import { formatAge } from './agent';
import { hostedState, isSupervisor, STATE_LABEL, type Cockpit, type CockpitAction, type CockpitTrack, type Hosted } from './harness';

/**
 * The cockpit's read side (MCR-96). Two kinds of text are kept apart all the
 * way to the screen: what a session published (its words, with who said it
 * and when) and what the harness knows (state, prompts, waits), which is asked
 * again at every display and never taken from the published text.
 */

/** A published entry not touched for this long is marked as possibly out of date. */
export const STALE_AFTER_MS = 6 * 3600_000;

/** How the root Supervisor's own part is keyed in the cockpit. */
export const ROOT_PART = 'supervisor';

const URGENCY = { now: 0, today: 1, whenever: 2 } as const;

/**
 * Whether the harness itself knows that this row needs the person: a row it
 * derived, or a published action into which it merged what it knows of that
 * session (MCR-118). Such a row is ranked and kept in sight as the harness's own.
 */
export const harnessSaw = (a: CockpitAction) => !!a.derived || !!(a.live && (a.live.prompt || a.live.held || a.live.report || a.live.waits?.length));

/**
 * The harness's urgency for a row, if it has one: a prompt holds an agent in
 * the middle of its turn (`now`); an unsent line, an open report and a late
 * wait for the person are `today`.
 */
export function harnessUrgency(a: CockpitAction): 'now' | 'today' | null {
  if (a.derived === 'prompt' || a.live?.prompt) return 'now';
  return harnessSaw(a) ? 'today' : null;
}

/**
 * How soon an action wants the person, lowest first. What the harness knows
 * comes before what a publisher claims: a publisher's urgency never ranks a
 * row above the harness's own. An action without urgency comes last.
 */
export function urgencyRank(a: CockpitAction): number {
  const harness = harnessUrgency(a);
  if (harness) return URGENCY[harness];
  return a.urgency ? URGENCY[a.urgency] : URGENCY.whenever;
}

/** The urgency a row shows: the harness's where it knows one, else the publisher's; none on a row that is behind. */
export const shownUrgency = (a: CockpitAction) => (stillAwaits(a) ? harnessUrgency(a) ?? a.urgency ?? '' : '');

/** Since when an action stands: what the service saw for a derived one, else when it was first published. */
export const actionSince = (a: CockpitAction) => a.since || a.updated || 0;

/**
 * An action that still stands as published. Not one the harness knows to be
 * behind: the operator typed into its session since it was published, or
 * that session is no more (MCR-103). Such a row stays in sight, after the
 * others and without its urgency, until its publisher updates or removes it.
 */
export const stillAwaits = (a: CockpitAction) => !a.ownerTyped && !a.sessionEnded;

/**
 * "Needs you": what the harness itself saw (a prompt, an open report) first,
 * whatever a session published as urgent; then what still stands, by urgency,
 * then the oldest first; what is behind last. Urgency is a publisher's claim:
 * it orders published rows among themselves and never puts one above the
 * harness's own. An action without a time comes last in its group.
 */
export function needsYouRows(cockpit: Cockpit): CockpitAction[] {
  const age = (a: CockpitAction) => actionSince(a) || Number.MAX_SAFE_INTEGER;
  return [...cockpit.actions].sort((a, b) => Number(!harnessSaw(a)) - Number(!harnessSaw(b)) || Number(!stillAwaits(a)) - Number(!stillAwaits(b)) || urgencyRank(a) - urgencyRank(b) || age(a) - age(b) || a.id.localeCompare(b.id));
}

/** How many published rows of one publisher are shown before the rest folds. */
export const ROWS_PER_PUBLISHER = 3;

/**
 * The rows that are shown at once, and per publisher how many are folded
 * away: one session cannot push the others, or the harness's own rows, out
 * of sight by publishing many. `open` holds the publishers whose rows were unfolded.
 */
export function foldRows(rows: CockpitAction[], open: ReadonlySet<string>): { shown: CockpitAction[]; folded: Map<string, number> } {
  const seen = new Map<string, number>();
  const folded = new Map<string, number>();
  const shown = rows.filter(a => {
    // What the harness knows never folds away, also when it rides on a published row
    if (harnessSaw(a) || !a.by) return true;
    const n = (seen.get(a.by) ?? 0) + 1;
    seen.set(a.by, n);
    if (n <= ROWS_PER_PUBLISHER || open.has(a.by)) return true;
    folded.set(a.by, (folded.get(a.by) ?? 0) + 1);
    return false;
  });
  return { shown, folded };
}

/** Whether a click on this part of a published action is offered: it still stands, the panel knows its stamp, and the service has not said that its text would be refused. */
export function clickable(a: CockpitAction, part: 'say' | 'options' | 'url' | 'command' | 'ask'): boolean {
  if (a.derived || !a.by || !a.updated) return false;
  if (part === 'ask') return true;
  if ((part === 'say' || part === 'options') && !stillAwaits(a)) return false;
  // The session asks at a prompt: the service refuses to place a line there, so no button offers it
  if ((part === 'say' || part === 'options') && a.live?.prompt) return false;
  return !a.unclickable?.includes(part);
}

/**
 * How a track's state reads: the published word, unless the harness knows
 * that the operator has answered in its lead's terminal since. `old`: not
 * updated for `STALE_AFTER_MS` while it was not resting; the panel says that
 * once and quietly (a dimmed state and age), never as a word on the state (MCR-127).
 */
export function trackStateShown(t: CockpitTrack, now = Date.now()): { text: string; tone: CockpitTrack['state'] | 'answered'; old: boolean } {
  const old = isOld(t, now) && t.state !== 'done' && t.state !== 'parked';
  if (t.state === 'waiting_human' && t.ownerTyped) return { text: `you typed ${formatAge(t.ownerTyped, now)}`, tone: 'answered', old };
  return { text: TRACK_STATE[t.state], tone: t.state, old };
}

/** A published entry not updated for `STALE_AFTER_MS`: its text may be behind. */
export function isOld(entry: { updated?: number }, now = Date.now()): boolean {
  return !!entry.updated && now - entry.updated > STALE_AFTER_MS;
}

/** What the age of a published entry says in its tooltip. */
export function ageTitle(entry: { updated?: number }, now = Date.now()): string | undefined {
  if (!entry.updated) return undefined;
  const when = `Published ${formatAge(entry.updated, now)}`;
  return isOld(entry, now) ? `${when}. Not updated for more than ${STALE_AFTER_MS / 3600_000} h: the published text may be behind` : when;
}

/**
 * Who published a track, when it is worth saying: only when the publisher is
 * not its lead and not the Supervisor, whose panel this is and who publishes
 * most tracks led by others (MCR-127: "by Supervisor" stood on every row).
 */
export function trackPublisher(t: CockpitTrack): string | null {
  return t.by && t.by !== t.lead && t.by !== ROOT_PART ? t.by : null;
}

export const ACTION_KIND: Record<CockpitAction['kind'], string> = {
  typed_word: 'your word', decision: 'decision', secret_step: 'step only you can do', live_check: 'live check',
  external: 'outside', question: 'question', answer_prompt: 'prompt', report: 'report', held_line: 'unsent line', human_wait: 'waits for you',
};

/** How long a line has stood, in plain words: "45 s", "12 min", "2 h 5 min". */
export function heldFor(since: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/**
 * What the harness knows of a row's session, as chips: on a merged row each
 * fact it took in, on a derived unsent line how long it has stood. The
 * session's own text (what a wait is for, a report) is not a chip.
 */
export function harnessChips(a: CockpitAction, now = Date.now()): string[] {
  if (a.derived === 'held' && a.since) return [`unsent for ${heldFor(a.since, now)}`];
  const l = a.live;
  if (!l || a.derived) return [];
  return [
    l.prompt ? `at a prompt · ${formatAge(l.prompt, now)}` : '',
    // Never Ctrl+C: in a working agent it stops the turn (MCR-122)
    l.held ? `held for a line you have not sent there, ${heldFor(l.held, now)}: if its box is empty, press Enter there` : '',
    l.report ? `reported: needs you · ${formatAge(l.report.since, now)}` : '',
    ...(l.waits ?? []).map(w => `waits for you, late · since ${formatAge(w.since, now)}`),
  ].filter(Boolean);
}

export const TRACK_STATE: Record<CockpitTrack['state'], string> = {
  moving: 'moving', waiting_human: 'waits for you', blocked: 'blocked', parked: 'parked', done: 'done',
};

/** The session a cockpit entry names, as the harness has it now. */
export interface Named {
  id: string; name: string;
  /** In the session list now and running: its row and its terminal can be opened */
  hosted?: Hosted;
  /**
   * `gone`: the harness has no such session any more. `running` without
   * `hosted`: the service says it runs and the list has not shown it yet; it is
   * not called ended for that
   */
  standing: 'running' | 'ended' | 'gone';
}

/**
 * Join a session id from the cockpit with the live list. The list is the
 * newer word; the cockpit's own dictionary names sessions that ended or were
 * forgotten since.
 */
export function named(id: string, cockpit: Cockpit, hosted: Hosted[], label: (h: Hosted) => string): Named {
  if (id === ROOT_PART) {
    const root = hosted.find(h => !h.exit && isSupervisor(h));
    // Ended only when the list shows that: a list that has not caught up proves nothing
    return { id, name: 'Supervisor', hosted: root, standing: root || !hosted.some(h => h.exit && isSupervisor(h)) ? 'running' : 'ended' };
  }
  const h = hosted.find(x => x.id === id);
  const known = cockpit.sessions[id];
  if (h) return { id, name: label(h), hosted: h.exit ? undefined : h, standing: h.exit ? 'ended' : 'running' };
  if (!known || known.gone) return { id, name: known?.name || id, standing: 'gone' };
  return { id, name: known.name || id, standing: known.ended ? 'ended' : 'running' };
}

/** What the harness says of a session now, in words: state first, then only what is there. */
export function liveFacts(h: Hosted): string[] {
  const state = hostedState(h);
  return [
    STATE_LABEL[state],
    h.openTasks ? `${h.openTasks} open task${h.openTasks > 1 ? 's' : ''}` : '',
    h.unread ? `${h.unread} unread` : '',
    h.harness?.draft && (h.unread || h.openTasks) ? 'held: you have an unsent line there' : '',
    ...(h.waits ?? []).map(w => `waits for ${w.on}${w.overdue ? ' (late)' : ''}`),
  ].filter(Boolean);
}

/**
 * Why a published entry may not be true any more, besides its age (which the
 * row shows once, dimmed when old: `isOld`); empty when nothing says so.
 */
export function staleMarks(entry: { by?: string }, cockpit: Cockpit, hosted: Hosted[], label: (h: Hosted) => string): string[] {
  const marks: string[] = [];
  if (entry.by) {
    const by = named(entry.by, cockpit, hosted, label);
    if (by.standing !== 'running') marks.push(by.standing === 'gone' ? 'its publisher is gone' : `its publisher ${by.name} ended`);
  }
  return marks;
}

/** Whom or what a track waits on, from its items: each once, the person first. */
export function trackWaits(track: CockpitTrack, name: (id: string) => string): string[] {
  const out: string[] = [];
  for (const item of track.items ?? []) {
    const w = item.waitsOn;
    if (!w || item.state === 'done') continue;
    // The operator has typed in the lead's terminal since: "waits on you" is no longer the harness's to repeat
    if (w.kind === 'human' && track.ownerTyped) continue;
    const on = w.kind === 'human' ? 'you' : w.kind === 'session' && w.who ? name(w.who) : w.what || w.kind;
    if (!out.includes(on)) out.push(on);
  }
  return out.sort((a, b) => Number(b === 'you') - Number(a === 'you'));
}

/** The line under an action that says whose words it is: "published by X · 12 min ago", or that the harness saw it. */
export function actionSource(a: CockpitAction, by: string, now = Date.now()): string {
  if (a.derived) return `seen by the harness${actionSince(a) ? ` · ${formatAge(actionSince(a), now)}` : ''}`;
  return `published by ${by}${a.updated ? ` · ${formatAge(a.updated, now)}` : ''}`;
}
