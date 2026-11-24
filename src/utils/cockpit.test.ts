import { describe, expect, it } from 'vitest';
import { actionSource, ageTitle, attachTrack, clickable, foldRows, harnessChips, harnessSaw, heldFor, isOld, liveFacts, named, harnessMarks, needsYouRows, oneView, ROOT_PART, ROWS_PER_PUBLISHER, STALE_AFTER_MS, staleMarks, stillAwaits, shownUrgency, trackPublisher, trackStateShown, trackWaits, urgencyRank } from './cockpit';
import type { Cockpit, CockpitAction, CockpitTrack, Hosted } from './harness';

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
    expect(staleMarks({ by: 'a' }, doc, [], label)).toEqual([]);
  });
});

describe('stale marks', () => {
  const doc = cockpit({ sessions: { ended: { name: 'Old one', ended: true }, lost: { gone: true } } });
  const hosted = [session('a')];
  it('marks nothing for a running publisher, however old the entry: its age is the row\'s to show (MCR-127)', () => {
    const old = { by: 'a', updated: NOW - STALE_AFTER_MS - 3600_000 };
    expect(staleMarks(old, doc, hosted, label)).toEqual([]);
  });
  it('marks an entry whose publisher ended or is gone', () => {
    expect(staleMarks({ by: 'ended' }, doc, hosted, label)).toEqual(['its publisher Old one ended']);
    expect(staleMarks({ by: 'lost' }, doc, hosted, label)).toEqual(['its publisher is gone']);
  });
  it('says an entry is old once, in the tooltip of its age', () => {
    expect(isOld({ updated: NOW - STALE_AFTER_MS + 1000 }, NOW)).toBe(false);
    expect(isOld({ updated: NOW - STALE_AFTER_MS - 1 }, NOW)).toBe(true);
    expect(isOld({}, NOW)).toBe(false);
    expect(ageTitle({ updated: NOW - 60_000 }, NOW)).toBe('Published 1 min ago');
    expect(ageTitle({ updated: NOW - STALE_AFTER_MS - 3600_000 }, NOW)).toBe('Published 7 h ago. Not updated for more than 6 h: the published text may be behind');
    expect(ageTitle({}, NOW)).toBeUndefined();
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

  it('reads a waiting track as answered once the owner typed in its lead, and an old one as old without a word on its state', () => {
    const track = { id: 't', title: 'T', lead: 'a', by: 'a', state: 'waiting_human' as const, updated: NOW - 40 * 60000 };
    expect(trackStateShown(track, NOW)).toEqual({ text: 'waits for you', tone: 'waiting_human', old: false });
    expect(trackStateShown({ ...track, ownerTyped: NOW - 36 * 60000 }, NOW)).toEqual({ text: 'you typed 36 min ago', tone: 'answered', old: false });
    // Only a track that says it waits for the owner is answered by their typing
    expect(trackStateShown({ ...track, state: 'moving', ownerTyped: NOW }, NOW).tone).toBe('moving');
    // Old: said once and quietly by the row, never as "stale:" on the state (MCR-127)
    expect(trackStateShown({ ...track, state: 'moving', updated: NOW - STALE_AFTER_MS - 1 }, NOW)).toEqual({ text: 'moving', tone: 'moving', old: true });
    expect(trackStateShown({ ...track, updated: NOW - STALE_AFTER_MS - 1 }, NOW)).toEqual({ text: 'waits for you', tone: 'waiting_human', old: true });
    // What rests is not old for resting
    expect(trackStateShown({ ...track, state: 'parked', updated: 1 }, NOW)).toEqual({ text: 'parked', tone: 'parked', old: false });
    expect(trackStateShown({ ...track, state: 'done', updated: 1 }, NOW).old).toBe(false);
  });

  it('names who published a track only when it is neither its lead nor the Supervisor (MCR-127)', () => {
    const track = { id: 't', title: 'T', lead: 'a', by: 'a', state: 'moving' as const };
    expect(trackPublisher(track)).toBeNull();
    expect(trackPublisher({ ...track, by: ROOT_PART })).toBeNull();
    expect(trackPublisher({ ...track, by: 'b' })).toBe('b');
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
    expect(chips).toEqual(['at a prompt · 1 min ago', 'held for a line you have not sent there, 3 min: if its box is empty, press Enter there', 'reported: needs you · just now', 'waits for you, late · since 1 h ago']);
    // The session's own words are not a chip
    expect(chips.join(' ')).not.toContain('Which key?');
    // Never Ctrl+C: in a working agent it stops the turn (MCR-122)
    expect(chips.join(' ')).not.toContain('Ctrl+C');
    expect(harnessChips(action('plain'), NOW)).toEqual([]);
  });

  it('offers no line to place while the session asks at a prompt', () => {
    const word = action('w', { kind: 'typed_word', say: 'go', updated: NOW, where: { session: 'x' } });
    expect(clickable(word, 'say')).toBe(true);
    expect(clickable({ ...word, live: { prompt: NOW } }, 'say')).toBe(false);
    expect(clickable({ ...word, options: ['a'], live: { prompt: NOW } }, 'options')).toBe(false);
    // Asking its publisher more stays possible
    expect(clickable({ ...word, live: { prompt: NOW } }, 'ask')).toBe(true);
    expect(clickable({ ...word, live: { held: NOW } }, 'say')).toBe(true);
  });
});

describe('one view: tracks with their needs (MCR-131)', () => {
  const track = (id: string, lead: string, by = lead, over: Partial<CockpitTrack> = {}): CockpitTrack => ({ id, title: id, lead, by, state: 'moving', ...over });
  const under = (id: string, supervisor: string | null, over: Partial<Hosted> = {}) => session(id, { harness: { name: id.toUpperCase(), named: true, profile: 'claude', state: 'working', supervisor } as Hosted['harness'], ...over });
  // lead leads `mem`; e1 works for lead, e2 for e1; loner works for nobody; sup is the root Supervisor
  const hosted = [session('sup', { meta: { label: 'Claude Code', profile: 'claude', role: 'supervisor' } }), under('lead', 'sup'), under('e1', 'lead'), under('e2', 'e1'), under('loner', null)];
  const tracks = [track('mem', 'lead'), track('infra', 'other', ROOT_PART), track('ops', 'ops-lead', ROOT_PART)];
  const ids = (rows: CockpitAction[]) => rows.map(a => a.id);

  it('attaches a need to its own track, of its publisher\'s part or of the part `trackBy` names', () => {
    expect(attachTrack(action('n', { by: 'lead', track: 'mem' }), tracks, hosted)?.id).toBe('mem');
    // The Supervisor files an action on another part's track
    expect(attachTrack(action('n', { by: ROOT_PART, track: 'mem', trackBy: 'lead' }), tracks, hosted)?.id).toBe('mem');
    // A track id of another part is not its own: it attaches by its session instead (here: none)
    expect(attachTrack(action('n', { by: 'loner', track: 'mem', where: { session: 'loner' } }), tracks, hosted)).toBeNull();
    // A track that does not exist falls through to the session's lead
    expect(attachTrack(action('n', { by: 'lead', track: 'nope', where: { session: 'e1' } }), tracks, hosted)?.id).toBe('mem');
  });

  it('attaches by `where.session` to the track its session leads, and to the track of the lead above an executor, two levels down', () => {
    expect(attachTrack(action('n', { by: 'x', where: { session: 'lead' } }), tracks, hosted)?.id).toBe('mem');
    expect(attachTrack(action('n', { by: 'x', where: { session: 'e1' } }), tracks, hosted)?.id).toBe('mem');
    expect(attachTrack(action('n', { by: 'x', where: { session: 'e2' } }), tracks, hosted)?.id).toBe('mem');
    // Without where.session, the publisher's own box is the session
    expect(attachTrack(action('n', { by: 'e2', where: {} }), tracks, hosted)?.id).toBe('mem');
    // The nearest lead wins: e1 leading a track of its own takes e2's needs
    expect(attachTrack(action('n', { by: 'x', where: { session: 'e2' } }), [...tracks, track('sub', 'e1')], hosted)?.id).toBe('sub');
    // A circle in the relation ends
    const circle = [under('c1', 'c2'), under('c2', 'c1')];
    expect(attachTrack(action('n', { by: 'x', where: { session: 'c1' } }), tracks, circle)).toBeNull();
  });

  it('attaches derived prompt and held rows the same way', () => {
    const prompt = action('prompt:e2', { kind: 'answer_prompt', derived: 'prompt', by: undefined, where: { session: 'e2' }, since: 1 });
    const held = action('held:lead', { kind: 'held_line', derived: 'held', by: undefined, where: { session: 'lead' }, since: 2 });
    const loose = action('prompt:loner', { kind: 'answer_prompt', derived: 'prompt', by: undefined, where: { session: 'loner' }, since: 3 });
    const view = oneView(cockpit({ tracks, actions: [prompt, held, loose] }), hosted, new Set());
    expect(ids(view.tracks[0].rows)).toEqual(['prompt:e2', 'held:lead']);
    expect(view.tracks[0].marks).toEqual(['at a prompt', 'unsent line']);
    expect(ids(view.unassigned!.rows)).toEqual(['prompt:loner']);
  });

  it('attaches a need for the root Supervisor to the first track the Supervisor published', () => {
    expect(attachTrack(action('n', { by: ROOT_PART, where: { session: 'sup' } }), tracks, hosted)?.id).toBe('infra');
    expect(attachTrack(action('n', { by: ROOT_PART }), tracks, hosted)?.id).toBe('infra');
    // A track the Supervisor leads itself comes first
    expect(attachTrack(action('n', { by: ROOT_PART }), [...tracks, track('own', 'sup', ROOT_PART)], hosted)?.id).toBe('own');
  });

  it('puts a need whose track was removed under Unassigned, even when its session leads a track', () => {
    const a = action('n', { by: 'lead', track: 'gone', trackMissing: true, where: { session: 'lead' } });
    expect(attachTrack(a, tracks, hosted)).toBeNull();
    expect(ids(oneView(cockpit({ tracks, actions: [a] }), hosted, new Set()).unassigned!.rows)).toEqual(['n']);
  });

  it('orders a track\'s needs as the needs-you list did: the harness\'s first, then by urgency and age, what is behind last', () => {
    const actions = [
      action('late', { by: 'lead', track: 'mem', urgency: 'whenever', updated: 1 }),
      action('behind', { by: 'lead', track: 'mem', urgency: 'now', updated: 2, ownerTyped: 5 }),
      action('soon', { by: 'lead', track: 'mem', urgency: 'now', updated: 9 }),
      action('older', { by: 'lead', track: 'mem', urgency: 'now', updated: 3 }),
      action('prompt:e1', { kind: 'answer_prompt', derived: 'prompt', by: undefined, where: { session: 'e1' }, since: 7 }),
    ];
    // Unfolded: four rows of one publisher would fold the fourth
    expect(ids(oneView(cockpit({ tracks, actions }), hosted, new Set(['lead'])).tracks[0].rows)).toEqual(['prompt:e1', 'older', 'soon', 'late', 'behind']);
  });

  it('keeps tracks in published order and shows Unassigned only when it holds a need', () => {
    const attached = oneView(cockpit({ tracks, actions: [action('n', { by: 'lead', track: 'mem' })] }), hosted, new Set());
    expect(attached.unassigned).toBeNull();
    expect(attached.tracks.map(g => g.track!.id)).toEqual(['mem', 'infra', 'ops']);
    expect(attached.tracks.map(g => g.rows.length)).toEqual([1, 0, 0]);
    expect(oneView(cockpit({ tracks: [] }), hosted, new Set()).unassigned).toBeNull();
    expect(oneView(cockpit({ tracks: [], actions: [action('n', { by: 'loner' })] }), hosted, new Set()).unassigned!.rows).toHaveLength(1);
  });

  it('still folds one publisher beyond the first few, counted over the whole view, and never the harness\'s rows', () => {
    // Five rows of `lead`, spread over its track and Unassigned, and a prompt
    const spread = [
      ...Array.from({ length: 3 }, (_, i) => action(`t${i}`, { by: 'lead', track: 'mem', urgency: 'now', updated: i + 1 })),
      ...Array.from({ length: 2 }, (_, i) => action(`u${i}`, { by: 'lead', where: { session: 'loner' }, urgency: 'today', updated: i + 1 })),
      action('prompt:loner', { kind: 'answer_prompt', derived: 'prompt', by: undefined, where: { session: 'loner' }, since: 9 }),
    ];
    const view = oneView(cockpit({ tracks, actions: spread }), hosted, new Set());
    expect(ids(view.tracks[0].rows)).toEqual(['t0', 't1', 't2']);
    expect(ids(view.unassigned!.rows)).toEqual(['prompt:loner']);
    expect([...view.unassigned!.folded]).toEqual([['lead', 2]]);
    expect(view.tracks[0].folded.size).toBe(0);
    const open = oneView(cockpit({ tracks, actions: spread }), hosted, new Set(['lead']));
    expect(ids(open.unassigned!.rows)).toEqual(['prompt:loner', 'u0', 'u1']);
    expect(open.unassigned!.folded.size).toBe(0);
  });

  it('marks what the harness saw among a group\'s needs, merged into a published row or derived, each kind once', () => {
    expect(harnessMarks([action('a', { live: { report: { id: 'r', since: 1, text: 't' } } }), action('w', { derived: 'wait' }), action('p', { live: { prompt: 1 } })])).toEqual(['at a prompt', 'open report', 'late wait']);
    expect(harnessMarks([action('plain'), action('k', { live: { reportOpen: true } })])).toEqual([]);
  });
});
