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
 * How soon an action wants the person, lowest first. A prompt holds an agent
 * in the middle of its turn, so it goes with `now`; an open report without a
 * published action goes with `today`; an action without urgency comes last.
 */
export function urgencyRank(a: CockpitAction): number {
  if (a.derived === 'prompt') return URGENCY.now;
  if (a.urgency) return URGENCY[a.urgency];
  return a.derived === 'report' ? URGENCY.today : URGENCY.whenever;
}

/** Since when an action stands: what the service saw for a derived one, else when it was first published. */
export const actionSince = (a: CockpitAction) => a.since || a.updated || 0;

/**
 * An action that still stands as published. Not one the harness knows to be
 * behind: the operator typed into its session since it was published, or
 * that session is no more (MCR-103). Such a row stays in sight, after the
 * others and without its urgency, until its publisher updates or removes it.
 */
export const stillAwaits = (a: CockpitAction) => !a.ownerTyped && !a.sessionEnded;

/** "Needs you": what still stands first, by urgency, then the oldest first. An action without a time comes last in its group. */
export function needsYouRows(cockpit: Cockpit): CockpitAction[] {
  const age = (a: CockpitAction) => actionSince(a) || Number.MAX_SAFE_INTEGER;
  return [...cockpit.actions].sort((a, b) => Number(!stillAwaits(a)) - Number(!stillAwaits(b)) || urgencyRank(a) - urgencyRank(b) || age(a) - age(b) || a.id.localeCompare(b.id));
}

/** How a track's state reads: the published word, unless the harness knows that the operator has answered in its lead's terminal since. */
export function trackStateShown(t: CockpitTrack, now = Date.now()): { text: string; tone: CockpitTrack['state'] | 'answered' | 'stale' } {
  if (t.state === 'waiting_human' && t.ownerTyped) return { text: `you typed ${formatAge(t.ownerTyped, now)}`, tone: 'answered' };
  if (t.updated && now - t.updated > STALE_AFTER_MS && t.state !== 'done' && t.state !== 'parked') return { text: `stale: ${TRACK_STATE[t.state]}`, tone: 'stale' };
  return { text: TRACK_STATE[t.state], tone: t.state };
}

export const ACTION_KIND: Record<CockpitAction['kind'], string> = {
  typed_word: 'your word', decision: 'decision', secret_step: 'step only you can do', live_check: 'live check',
  external: 'outside', answer_prompt: 'prompt', report: 'report',
};

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

/** Why a published entry may not be true any more; empty when nothing says so. */
export function staleMarks(entry: { by?: string; updated?: number }, cockpit: Cockpit, hosted: Hosted[], label: (h: Hosted) => string, now = Date.now()): string[] {
  const marks: string[] = [];
  if (entry.by) {
    const by = named(entry.by, cockpit, hosted, label);
    if (by.standing !== 'running') marks.push(by.standing === 'gone' ? 'its publisher is gone' : `its publisher ${by.name} ended`);
  }
  if (entry.updated && now - entry.updated > STALE_AFTER_MS) marks.push(`not updated since ${formatAge(entry.updated, now)}`);
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
