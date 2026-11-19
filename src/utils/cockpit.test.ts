import { describe, expect, it } from 'vitest';
import { actionSource, liveFacts, named, needsYouRows, STALE_AFTER_MS, staleMarks, trackWaits, urgencyRank } from './cockpit';
import type { Cockpit, CockpitAction, Hosted } from './harness';

const NOW = 100 * 3600_000;
const session = (id: string, over: Partial<Hosted> = {}): Hosted => ({ id, pid: 1, argv: ['claude'], cwd: '/work', started: 1, cols: 80, rows: 24, title: '', lastOutput: 1, exit: null, meta: { label: 'Claude Code', profile: 'claude' }, harness: { name: id.toUpperCase(), named: true, profile: 'claude', state: 'working' } as Hosted['harness'], ...over });
const label = (h: Hosted) => h.harness?.name ?? h.id;
const action = (id: string, over: Partial<CockpitAction> = {}): CockpitAction => ({ id, title: id, kind: 'decision', by: 'a', ...over });
const cockpit = (over: Partial<Cockpit> = {}): Cockpit => ({ schema: 1, version: 1, updated: NOW, tracks: [], actions: [], sessions: {}, ...over });

describe('needs you', () => {
  it('orders by urgency, then the oldest first, and keeps a prompt with the most urgent', () => {
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
    expect(rows.map(a => a.id)).toEqual(['prompt', 'now-new', 'now-undated', 'today-old', 'report', 'today-new', 'later', 'none']);
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
    expect(named('supervisor', doc, [hosted[0]], label).standing).toBe('ended');
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
