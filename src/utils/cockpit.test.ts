import { describe, expect, it } from 'vitest';
import { actionSource, clickable, foldRows, harnessChips, harnessSaw, heldFor, liveFacts, named, needsYouRows, ROWS_PER_PUBLISHER, STALE_AFTER_MS, staleMarks, stillAwaits, shownUrgency, trackStateShown, trackWaits, urgencyRank } from './cockpit';
import type { Cockpit, CockpitAction, Hosted } from './harness';

const NOW = 100 * 3600_000;
const session = (id: string, over: Partial<Hosted> = {}): Hosted => ({ id, pid: 1, argv: ['claude'], cwd: '/work', started: 1, cols: 80, rows: 24, title: '', lastOutput: 1, exit: null, meta: { label: 'Claude Code', profile: 'claude' }, harness: { name: id.toUpperCase(), named: true, profile: 'claude', state: 'working' } as Hosted['harness'], ...over });
const label = (h: Hosted) => h.harness?.name ?? h.id;
const action = (id: string, over: Partial<CockpitAction> = {}): CockpitAction => ({ id, title: id, kind: 'decision', by: 'a', ...over });
const cockpit = (over: Partial<Cockpit> = {}): Cockpit => ({ schema: 1, version: 1, updated: NOW, tracks: [], actions: [], sessions: {}, ...over });

describe('needs you', () => {
  it('puts what the harness saw first, then orders published rows by urgency and the oldest first', () => {
    const rows = needsYouRows(cockpit({ actions: [
      action('later', { urgency: 'whenever', updated: 1 }),
      action('none', { updated: 2 }),
      action('today-new', { urgency: 'today', updated: 50 }),
      action('report', { kind: 'report', derived: 'report', since: 20 }),
      action('now-new', { urgency: 'now', updated: 40 }),
      action('prompt', { kind: 'answer_prompt', derived: 'prompt', since: 30 }),
      action('today-old', { urgency: 'today', updated: 10 }),
      action('now-undated', { urgency: 'now' }),
    ] }));
    // A published "now" is its publisher's claim: it never stands above the harness's own rows
    expect(rows.map(a => a.id)).toEqual(['prompt', 'report', 'now-new', 'now-undated', 'today-old', 'today-new', 'later', 'none']);
    expect(urgencyRank(action('x'))).toBe(2);
  });

  it('says whose words an action is', () => {
    expect(actionSource(action('a', { updated: NOW - 12 * 60000 }), 'Builder', NOW)).toBe('published by Builder · 12 min ago');
    expect(actionSource(action('p', { derived: 'prompt', since: NOW - 3 * 60000 }), '', NOW)).toBe('seen by the harness · 3 min ago');
  });
});

describe('the join with the session list', () => {
  const doc = cockpit({ sessions: { a: { name: 'stale name', state: 'idle' }, ended: { name: 'Old one', ended: true }, lost: { gone: true } } });
  const hosted = [session('a'), session('root', { meta: { label: 'Claude Code', profile: 'claude', role: 'supervisor' } }), session('x', { exit: { code: 0, signal: null, at: 5 } })];

  it('takes name and state from the live list, never from the published document', () => {
    const a = named('a', doc, hosted, label);
    expect([a.name, a.standing, a.hosted?.id]).toEqual(['A', 'running', 'a']);
    expect(liveFacts({ ...hosted[0], openTasks: 2, unread: 1, harness: { ...hosted[0].harness!, state: 'waiting', draft: true }, waits: [{ id: 'w', kind: 'pipeline', on: 'CI run 7', ref: '', since: 1, expectBy: 2, overdue: true, escalated: null }] }))
      .toEqual(['waiting for you', '2 open tasks', '1 unread', 'held: you have an unsent line there', 'waits for CI run 7 (late)']);
    expect(liveFacts(hosted[0])).toEqual(['working']);
  });

  it('names a session that ended or is gone without a way to open it', () => {
    expect(named('ended', doc, hosted, label)).toEqual({ id: 'ended', name: 'Old one', standing: 'ended' });
    expect(named('lost', doc, hosted, label)).toEqual({ id: 'lost', name: 'lost', standing: 'gone' });
    expect(named('never', doc, hosted, label).standing).toBe('gone');
    expect(named('x', doc, hosted, label)).toMatchObject({ standing: 'ended', hosted: undefined });
  });

  it('finds the root Supervisor behind its part key', () => {
    expect(named('supervisor', doc, hosted, label)).toMatchObject({ name: 'Supervisor', standing: 'running', hosted: { id: 'root' } });
    // Not in the list yet is not ended; an exited Supervisor row is
    expect(named('supervisor', doc, [hosted[0]], label)).toMatchObject({ standing: 'running', hosted: undefined });
    expect(named('supervisor', doc, [{ ...hosted[1], exit: { code: 0, signal: null, at: 5 } }], label).standing).toBe('ended');
  });

  it('does not call a session ended because the list has not shown it yet', () => {
    const late = named('a', doc, [], label);
    expect(late).toEqual({ id: 'a', name: 'stale name', standing: 'running' });
    expect(staleMarks({ by: 'a', updated: NOW }, doc, [], label, NOW)).toEqual([]);
  });
});

describe('stale marks', () => {
  const doc = cockpit({ sessions: { ended: { name: 'Old one', ended: true }, lost: { gone: true } } });
  const hosted = [session('a')];
  it('marks nothing on a fresh entry of a running publisher', () => {
    expect(staleMarks({ by: 'a', updated: NOW - STALE_AFTER_MS + 1000 }, doc, hosted, label, NOW)).toEqual([]);
  });
  it('marks an entry older than the limit, and one whose publisher ended or is gone', () => {
    expect(staleMarks({ by: 'a', updated: NOW - STALE_AFTER_MS - 3600_000 }, doc, hosted, label, NOW)).toEqual(['not updated since 7 h ago']);
    expect(staleMarks({ by: 'ended', updated: NOW }, doc, hosted, label, NOW)).toEqual(['its publisher Old one ended']);
    expect(staleMarks({ by: 'lost', updated: NOW - 2 * STALE_AFTER_MS }, doc, hosted, label, NOW)).toEqual(['its publisher is gone', 'not updated since 12 h ago']);
  });
});

it('says whom a track waits on from its open items, you first, each once', () => {
  const waits = trackWaits({ id: 't', title: 'T', lead: 'a', state: 'moving', by: 'a', items: [
    { id: '1', title: 'one', owner: 'a', state: 'waiting', waitsOn: { kind: 'ci', what: 'CI run 7' } },
    { id: '2', title: 'two', owner: 'a', state: 'waiting', waitsOn: { kind: 'session', who: 'b' } },
    { id: '3', title: 'three', owner: 'human', state: 'waiting', waitsOn: { kind: 'human', what: 'merge word' } },
    { id: '4', title: 'four', owner: 'a', state: 'review', waitsOn: { kind: 'session', who: 'b' } },
    { id: '5', title: 'five', owner: 'a', state: 'done', waitsOn: { kind: 'timer', what: 'never shown' } },
  ] }, id => `S-${id}`);
  expect(waits).toEqual(['you', 'CI run 7', 'S-b']);
});

describe('what the harness knows to be behind (MCR-103)', () => {
  it('puts an action the owner already typed for, or whose session ended, after what still stands', () => {
    const rows = needsYouRows(cockpit({ actions: [
      action('typed-now', { urgency: 'now', updated: 1, ownerTyped: 5 }),
      action('ended-now', { urgency: 'now', updated: 2, sessionEnded: true }),
      action('whenever', { urgency: 'whenever', updated: 3 }),
      action('today', { urgency: 'today', updated: 4 }),
    ] }));
    expect(rows.map(a => a.id)).toEqual(['today', 'whenever', 'typed-now', 'ended-now']);
    expect(rows.map(stillAwaits)).toEqual([true, true, false, false]);
  });

  it('reads a waiting track as answered once the owner typed in its lead, and an old one as stale', () => {
    const track = { id: 't', title: 'T', lead: 'a', by: 'a', state: 'waiting_human' as const, updated: NOW - 40 * 60000 };
    expect(trackStateShown(track, NOW)).toEqual({ text: 'waits for you', tone: 'waiting_human' });
    expect(trackStateShown({ ...track, ownerTyped: NOW - 36 * 60000 }, NOW)).toEqual({ text: 'you typed 36 min ago', tone: 'answered' });
    // Only a track that says it waits for the owner is answered by their typing
    expect(trackStateShown({ ...track, state: 'moving', ownerTyped: NOW }, NOW).tone).toBe('moving');
    expect(trackStateShown({ ...track, state: 'moving', updated: NOW - STALE_AFTER_MS - 1 }, NOW)).toEqual({ text: 'stale: moving', tone: 'stale' });
    expect(trackStateShown({ ...track, updated: NOW - STALE_AFTER_MS - 1 }, NOW).tone).toBe('stale');
    // What rests is not stale for resting
    expect(trackStateShown({ ...track, state: 'parked', updated: 1 }, NOW).tone).toBe('parked');
    expect(trackStateShown({ ...track, state: 'done', updated: 1 }, NOW).tone).toBe('done');
  });

  it('no longer says that a track waits on the owner once they typed there', () => {
    const items = [{ id: '1', title: 'one', owner: 'human', state: 'waiting' as const, waitsOn: { kind: 'human' as const, what: 'a word' } }, { id: '2', title: 'two', owner: 'a', state: 'waiting' as const, waitsOn: { kind: 'ci' as const, what: 'CI' } }];
    const track = { id: 't', title: 'T', lead: 'a', by: 'a', state: 'waiting_human' as const, items };
    expect(trackWaits(track, id => id)).toEqual(['you', 'CI']);
    expect(trackWaits({ ...track, ownerTyped: 5 }, id => id)).toEqual(['CI']);
  });
});

describe('clicks (MCR-97)', () => {
  it('folds the rows of one publisher beyond the first few, and never the harness\'s own', () => {
    const many = Array.from({ length: 6 }, (_, i) => action(`a${i}`, { by: 'noisy', urgency: 'now', updated: i + 1 }));
    const rows = needsYouRows(cockpit({ actions: [...many, action('other', { by: 'calm', updated: 9 }), action('p1', { derived: 'prompt', kind: 'answer_prompt', since: 1, by: undefined }), action('p2', { derived: 'prompt', kind: 'answer_prompt', since: 2, by: undefined })] }));
    const { shown, folded } = foldRows(rows, new Set());
    expect(shown.map(a => a.id)).toEqual(['p1', 'p2', 'a0', 'a1', 'a2', 'other']);
    expect([...folded]).toEqual([['noisy', 6 - ROWS_PER_PUBLISHER]]);
    const open = foldRows(rows, new Set(['noisy']));
    expect(open.shown).toHaveLength(9);
    expect(open.folded.size).toBe(0);
  });

  it('offers a click only on a published action that stands, whose stamp is known and whose text the service lets through', () => {
    const a = action('a', { updated: 5 });
    expect(['say', 'options', 'url', 'command', 'ask'].map(p => clickable(a, p as 'say'))).toEqual([true, true, true, true, true]);
    expect(clickable(action('a'), 'say')).toBe(false);
    expect(clickable(action('a', { updated: 5, by: undefined }), 'say')).toBe(false);
    expect(clickable(action('a', { updated: 5, derived: 'prompt' }), 'ask')).toBe(false);
    // Behind what happened since: nothing is placed, a link or a command may still be looked at
    const behind = action('a', { updated: 5, ownerTyped: 9 });
    expect([clickable(behind, 'say'), clickable(behind, 'options'), clickable(behind, 'url'), clickable(behind, 'command')]).toEqual([false, false, true, true]);
    expect(clickable(action('a', { updated: 5, sessionEnded: true }), 'say')).toBe(false);
    const old = action('a', { updated: 5, unclickable: ['say', 'url'] });
    expect([clickable(old, 'say'), clickable(old, 'options'), clickable(old, 'url'), clickable(old, 'command')]).toEqual([false, true, false, true]);
  });
});

describe('what the harness knows, derived or merged (MCR-118)', () => {
  it('ranks a published row that carries a harness fact with the harness rows, at the harness urgency', () => {
    const rows = needsYouRows(cockpit({ actions: [
      action('claims-now', { urgency: 'now', updated: 1 }),
      action('held', { kind: 'held_line', derived: 'held', since: 5 }),
      action('merged-prompt', { urgency: 'whenever', updated: 9, where: { session: 'x' }, live: { prompt: 8 } }),
      action('wait', { kind: 'human_wait', derived: 'wait', since: 2 }),
      action('report-only', { updated: 3, live: { reportOpen: true } }),
    ] }));
    expect(rows.map(a => a.id)).toEqual(['merged-prompt', 'wait', 'held', 'claims-now', 'report-only']);
    // A publisher's "whenever" does not hide the harness's "now"; a merged held line is "today"
    expect(shownUrgency(action('m', { urgency: 'whenever', live: { prompt: 1 } }))).toBe('now');
    expect(shownUrgency(action('m', { urgency: 'now', live: { held: 1 } }))).toBe('today');
    // "reportOpen" alone is the publisher's own citation, not a fact the harness adds
    expect(harnessSaw(action('r', { live: { reportOpen: true } }))).toBe(false);
    // Behind: no urgency at all
    expect(shownUrgency(action('b', { live: { prompt: 1 }, ownerTyped: 2 }))).toBe('');
  });

  it('never folds a row the harness knows about, also when one publisher has many', () => {
    const many = Array.from({ length: ROWS_PER_PUBLISHER + 2 }, (_, i) => action(`p${i}`, { by: 'busy', updated: i + 1 }));
    many.push(action('merged', { by: 'busy', updated: 99, live: { held: 1 } }));
    const { shown, folded } = foldRows(needsYouRows(cockpit({ actions: many })), new Set());
    expect(shown.map(a => a.id)).toContain('merged');
    expect(folded.get('busy')).toBe(2);
  });

  it('says how long a line has stood, and what was merged, as chips', () => {
    expect([heldFor(NOW - 45_000, NOW), heldFor(NOW - 12 * 60_000, NOW), heldFor(NOW - 125 * 60_000, NOW), heldFor(NOW - 120 * 60_000, NOW)]).toEqual(['45 s', '12 min', '2 h 5 min', '2 h']);
    expect(harnessChips(action('h', { kind: 'held_line', derived: 'held', since: NOW - 12 * 60_000 }), NOW)).toEqual(['unsent for 12 min']);
    const chips = harnessChips(action('m', { live: { prompt: NOW - 60_000, held: NOW - 3 * 60_000, report: { id: 'r', since: NOW, text: 'Which key?' }, waits: [{ id: 'w', on: 'a go', since: NOW - 3600_000 }] } }), NOW);
    expect(chips).toEqual(['at a prompt · 1 min ago', 'your unsent line there for 3 min: Enter sends it, Ctrl+C clears it', 'reported: needs you · just now', 'waits for you, late · since 1 h ago']);
    // The session's own words are not a chip
    expect(chips.join(' ')).not.toContain('Which key?');
    expect(harnessChips(action('plain'), NOW)).toEqual([]);
  });
});
