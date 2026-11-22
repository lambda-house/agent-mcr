import { describe, expect, it } from 'vitest';
import { normalizeLiveList } from '../store';
import { agentProfileTitle, DEFAULT_LIVE_LIST, folderVisibility, temporaryFolder, type DirSection, gist, heldNote, hostedLabel, hostedState, pastedImage, pointerSpans, programHint, runningFor, sessionLinks, sessionReference, sessionSummary, shellQuote, type Hosted, relationRows, executorsBelow, supervisorChoices, reportGroups, type Report } from './harness';

const hosted = (over: Partial<Hosted> = {}): Hosted => ({ id: 'a', pid: 1, argv: ['/bin/zsh', '-l', '-i', '-c', 'exec codex'], cwd: '/w', started: 0, cols: 80, rows: 24, title: '', lastOutput: 0, exit: null, meta: {}, ...over });

function transfer(items: { kind: string; type: string }[]): DataTransfer {
  const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
  return { items: items.map(i => ({ ...i, getAsFile: () => (i.kind === 'file' ? file : null) })) } as unknown as DataTransfer;
}

describe('session summary', () => {
  const tracked = (over: object) => hosted({ harness: { name: '', profile: 'claude', state: 'idle', since: 1_000, precise: true, agentSession: null, attention: null, lastMessage: null, ...over } as Hosted['harness'] });
  const now = 1_000 + 12 * 60_000;
  it('takes the first plain line of a message', () => {
    expect(gist('\n## Done\n\nMore below')).toBe('Done');
    expect(gist('```\ncode\n```')).toBe('code');
    expect(gist('- **Fixed** the `parser` ([PR](https://x/1))')).toBe('Fixed the parser (PR)');
    expect(gist('x'.repeat(300), 20)).toBe(`${'x'.repeat(19)}…`);
  });
  it('says what a working session does and what an idle one finished with', () => {
    expect(sessionSummary(tracked({ state: 'working', status: 'running the regrade' }), now)).toMatchObject({ lead: 'Working 12m', text: 'running the regrade' });
    // Still shown at work without a status: how long it has been at it
    expect(sessionSummary(tracked({ state: 'working' }), now)).toMatchObject({ lead: 'Working 12m', text: '' });
    // A finished turn: how its last message begins, timed from when it ended; the rest is in the tooltip
    const done = sessionSummary(tracked({ status: 'reviewing', lastMessage: '**All 69 tests pass.**\n\nDetails…', lastMessageAt: now - 5 * 60_000 }), now);
    expect(done).toMatchObject({ lead: 'Done 5m ago', text: 'All 69 tests pass.' });
    expect(done?.full).toBe('Status: reviewing\n\nLast message:\n**All 69 tests pass.**\n\nDetails…');
    // No message yet: its own status
    expect(sessionSummary(tracked({ status: 'waiting for CI' }), now)).toMatchObject({ lead: 'Idle 12m', text: 'waiting for CI' });
    expect(sessionSummary(tracked({}), now)).toBeNull();
    expect(sessionSummary(hosted({ exit: { code: 0, signal: null, at: 1 } }), now)).toBeNull();
  });
});

describe('harness helpers', () => {
  it('replaces generic agent names with indexed conversation titles while keeping assigned names', () => {
    const session = hosted({ title: 'Codex | /work/api', meta: { profile: 'codex', label: 'Codex' }, harness: { name: 'Codex', named: false, profile: 'codex', since: 0, precise: true, agentSession: 'conversation', attention: null, lastMessage: null, state: 'idle' } });
    const titles = { conversation: 'Fix authentication retries' };
    expect(hostedLabel(session, titles)).toBe('Fix authentication retries');
    expect(hostedLabel({ ...session, meta: { ...session.meta, name: 'Reviewer' } }, titles)).toBe('Reviewer');
    expect(hostedLabel({ ...session, harness: { ...session.harness!, named: true } }, titles)).toBe('Codex');
    expect(hostedLabel({ ...session, harness: { ...session.harness!, name: 'API maintainer' } }, titles)).toBe('API maintainer');
    expect(hostedLabel(session)).toBe('Codex');
  });
  it('escapes pasted paths the way Terminal does for dropped files', () => {
    expect(shellQuote('/Users/me/Library/Caches/agent-mcr/a.png')).toBe('/Users/me/Library/Caches/agent-mcr/a.png');
    expect(shellQuote("/tmp/my shot (1)'s.png")).toBe("/tmp/my\\ shot\\ \\(1\\)\\'s.png");
  });
  it('takes an image only when the clipboard holds no text', () => {
    expect(pastedImage(transfer([{ kind: 'file', type: 'image/png' }]))?.name).toBe('x.png');
    expect(pastedImage(transfer([{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/png' }]))).toBeNull();
    expect(pastedImage(transfer([{ kind: 'file', type: 'application/pdf' }]))).toBeNull();
    expect(pastedImage(null)).toBeNull();
  });
  it('labels sessions and reads their exit state', () => {
    expect(hostedLabel(hosted({ meta: { label: 'Claude Code' } }))).toBe('Claude Code');
    expect(hostedLabel(hosted())).toBe('codex');
    expect(hostedState(hosted())).toBe('running');
    expect(hostedState(hosted({ exit: { code: 0, signal: null, at: 1 } }))).toBe('exited');
    expect(hostedState(hosted({ exit: { code: 1, signal: null, at: 1 } }))).toBe('failed');
    const tracked = { name: 'reviewer', profile: 'claude', since: 0, precise: true, agentSession: null, attention: null, lastMessage: null };
    expect(hostedState(hosted({ harness: { ...tracked, state: 'waiting' } }))).toBe('waiting');
    expect(hostedState(hosted({ harness: { ...tracked, state: 'unknown' } }))).toBe('running');
    expect(hostedState(hosted({ harness: { ...tracked, state: 'working' }, exit: { code: 0, signal: null, at: 1 } }))).toBe('exited');
    expect(hostedLabel(hosted({ meta: { label: 'Claude Code' }, harness: { ...tracked, state: 'idle' } }))).toBe('reviewer');
  });
});

describe('session reference', () => {
  it('carries nothing a shell would run or that ends the quotes or the line', () => {
    const named = (name: string) => sessionReference(hosted({ meta: { label: 'Claude Code', profile: 'claude', name } } as Partial<Hosted>));
    expect(named('Fixing tests')).toMatch(/^mcr:\S+ 'Fixing tests'$/);
    expect(named('a $(rm -rf ~) `id` \\ "b" \'c\'\nrm\u001b[0m')).toMatch(/^mcr:\S+ 'a \(rm -rf ~\) id {2}b crm\[0m'$/);
  });
});

describe('session pointers in terminal text', () => {
  const live = new Set(['a27f56d8749b', '5f7c7dccd5aa']);
  const links = (text: string) => sessionLinks(text, id => live.has(id));
  it('finds mcr:<id> of a known session, with where it is', () => {
    expect(links('type this in mcr:a27f56d8749b now')).toEqual([{ start: 13, end: 29, id: 'a27f56d8749b' }]);
    expect(links("(mcr:5f7c7dccd5aa 'Fixing tests'), then mcr:a27f56d8749b.").map(l => l.id)).toEqual(['5f7c7dccd5aa', 'a27f56d8749b']);
  });
  it('leaves an unknown id, a bare id and near misses as plain text', () => {
    expect(links('mcr:000000000000')).toEqual([]);
    expect(links('session a27f56d8749b')).toEqual([]);
    expect(links('mcr:a27f56d8749')).toEqual([]);
    expect(links('mcr:a27f56d8749b0')).toEqual([]);
    expect(links('mcr:A27F56D8749B')).toEqual([]);
    expect(links('xmcr:a27f56d8749b agent-mcr:a27f56d8749b')).toEqual([]);
    expect(links('mcr:<id>')).toEqual([]);
  });
});

describe('supervisors and executors', () => {
  const session = (id: string, cwd: string, supervisor?: string): Hosted => ({
    id, pid: 1, argv: ['claude'], cwd, started: 1, cols: 120, rows: 32, title: '', lastOutput: 1, exit: null,
    meta: { profile: 'claude', label: 'Claude Code' }, harness: { profile: 'claude', state: 'idle', name: id, supervisor } as Hosted['harness'],
  });

  it('lists a folder as trees: two supervisors, a three-level chain and an independent session', () => {
    const all = [
      session('lead', '/w'), session('solo', '/w'), session('worker', '/w', 'lead'), session('second', '/w'),
      session('helper', '/w', 'worker'), session('aide', '/w', 'second'), session('remote', '/other', 'lead'),
    ];
    const rows = relationRows(all.filter(h => h.cwd === '/w'), all);
    expect(rows.map(r => `${r.session.id}:${r.depth}`)).toEqual(['lead:0', 'worker:1', 'helper:2', 'solo:0', 'second:0', 'aide:1']);
    // An executor in another folder counts for its supervisor, and names it where it is listed
    expect(rows[0].executors).toBe(2);
    expect(rows.find(r => r.session.id === 'solo')?.executors).toBe(0);
    const elsewhere = relationRows(all.filter(h => h.cwd === '/other'), all);
    expect(elsewhere.map(r => [r.session.id, r.depth, r.elsewhere?.id])).toEqual([['remote', 0, 'lead']]);
  });

  it('keeps every session when a relation points nowhere or in a circle', () => {
    const all = [session('a', '/w', 'b'), session('b', '/w', 'a'), session('c', '/w', 'gone')];
    expect(relationRows(all, all).map(r => r.session.id).sort()).toEqual(['a', 'b', 'c']);
    expect([...executorsBelow('a', all)].sort()).toEqual(['a', 'b']);
  });

  it('knows who is below a session, so it is not offered as its supervisor', () => {
    const all = [session('lead', '/w'), session('worker', '/w', 'lead'), session('helper', '/w', 'worker'), session('solo', '/w')];
    expect([...executorsBelow('lead', all)].sort()).toEqual(['helper', 'worker']);
    expect(executorsBelow('solo', all).size).toBe(0);
  });
});

describe('reports by supervisor', () => {
  const session = (id: string, supervisor?: string, exit = false): Hosted => ({
    id, pid: 1, argv: ['claude'], cwd: '/w', started: 1, cols: 120, rows: 32, title: '', lastOutput: 1, exit: exit ? { code: 0, signal: null, at: 9 } : null,
    meta: { profile: 'claude', label: 'Claude Code' }, harness: { profile: 'claude', state: 'idle', supervisor } as Hosted['harness'],
  });
  const report = (id: string, from: string, kind: Report['kind'], created: number, supervisor?: string): Report => ({ id, session: from, name: from.toUpperCase(), cwd: '/w', kind, text: id, created, supervisor });
  const shape = (reports: Report[], hosted: Hosted[]) => reportGroups(reports, hosted).map(g => [g.session, g.rows.map(r => `${r.report.id}:${r.depth}`).join(' ')]);

  it('puts a supervisor first with its status on top, then its executors and theirs', () => {
    const hosted = [session('lead'), session('worker', 'lead'), session('helper', 'worker'), session('solo'), session('second'), session('aide', 'second')];
    const reports = [
      report('r1', 'worker', 'done', 1), report('r2', 'lead', 'done', 2), report('r3', 'solo', 'done', 3), report('r4', 'lead', 'status', 4),
      report('r5', 'helper', 'needs_human', 5), report('r6', 'worker', 'status', 6), report('r7', 'worker', 'done', 7), report('r8', 'aide', 'done', 8), report('r9', 'lead', 'done', 9),
    ];
    expect(shape(reports, hosted)).toEqual([
      // The group with the newest report first; 'second' has no report itself and still heads its group
      ['lead', 'r4:0 r9:0 r2:0 r6:1 r7:1 r1:1 r5:2'],
      ['second', 'r8:1'],
      ['', 'r3:0'],
    ]);
    const [lead, second] = reportGroups(reports, hosted);
    expect([lead.name, lead.live, second.name, second.live]).toEqual(['LEAD', true, 'Claude Code', true]);
  });

  it('keeps a session that ended under the supervisor its report names, and lists the rest newest first', () => {
    const hosted = [session('lead'), session('left', undefined, true), session('free')];
    const reports = [
      report('r1', 'gone', 'done', 1, 'lead'), report('r2', 'left', 'done', 2, 'lead'), report('r3', 'free', 'done', 3, 'lead'),
      report('r4', 'orphan', 'done', 4, 'nobody'), report('r5', 'old', 'done', 5),
    ];
    expect(shape(reports, hosted)).toEqual([
      // 'nobody' is known from a report only: its group says that it ended
      ['nobody', 'r4:1'],
      // 'free' is live and works for nobody now: what its old report recorded does not count
      ['lead', 'r1:1 r2:1'],
      ['', 'r5:0 r3:0'],
    ]);
    expect(reportGroups(reports, hosted).map(g => [g.name, g.live])).toEqual([['nobody', false], ['Claude Code', true], ['', false]]);
  });

  it('gives a supervisor its group before any executor has reported', () => {
    const root = { ...session('root'), meta: { role: 'supervisor' } };
    const hosted = [root, session('lead'), session('worker', 'lead'), session('solo')];
    const was = { ...report('r3', 'past', 'status', 3), executors: [{ session: 'x', name: 'X', state: 'idle', needsOperator: false, waits: [] }] };
    const groups = reportGroups([report('r1', 'root', 'status', 1), report('r2', 'lead', 'status', 2), was, report('r4', 'solo', 'status', 4)], hosted);
    expect(groups.map(g => [g.session, g.name, g.rows.length])).toEqual([['past', 'PAST', 1], ['lead', 'LEAD', 1], ['root', 'Supervisor', 1], ['', '', 1]]);
  });

  it('loses no report to a relation that goes in a circle', () => {
    const reports = [report('r1', 'a', 'done', 1, 'b'), report('r2', 'b', 'done', 2, 'a')];
    expect(reportGroups(reports, []).flatMap(g => g.rows.map(r => r.report.id)).sort()).toEqual(['r1', 'r2']);
    expect(reportGroups([], [session('lead')])).toEqual([]);
  });
});

describe('choosing a supervisor', () => {
  const session = (id: string, cwd: string, name: string): Hosted => ({
    id, pid: 1, argv: ['claude'], cwd, started: 1, cols: 120, rows: 32, title: '', lastOutput: 1, exit: null,
    meta: { profile: 'claude', label: 'Claude Code' }, harness: { profile: 'claude', state: 'idle', name } as Hosted['harness'],
  });
  const me = session('me', '/w', 'Me');
  const ids = (list: Hosted[]) => list.map(h => h.id);

  it('offers the sessions of the same folder first, each group by title without regard to case', () => {
    const { here, elsewhere } = supervisorChoices(me, [
      session('z', '/other', 'zebra'), session('b', '/w', 'beta'), session('a', '/other', 'Alpha'), session('c', '/w', 'Charlie'), session('d', '/w', 'alpha'),
    ]);
    expect(ids(here)).toEqual(['d', 'b', 'c']);
    expect(ids(elsewhere)).toEqual(['a', 'z']);
  });

  it('breaks a tie of titles by folder, then by id', () => {
    const { elsewhere } = supervisorChoices(me, [session('k2', '/b', 'Same'), session('k1', '/b', 'same'), session('k3', '/a', 'SAME')]);
    expect(ids(elsewhere)).toEqual(['k3', 'k1', 'k2']);
  });

  it('leaves a group empty when nothing belongs in it', () => {
    expect(supervisorChoices(me, [session('a', '/other', 'A')])).toEqual({ here: [], elsewhere: [expect.objectContaining({ id: 'a' })] });
    expect(supervisorChoices(me, [session('a', '/w', 'A')]).elsewhere).toEqual([]);
    expect(supervisorChoices(me, [])).toEqual({ here: [], elsewhere: [] });
  });
});

describe('heldNote', () => {
  const session = (draft: boolean, over: Partial<Hosted> = {}) => hosted({ harness: { name: '', profile: 'claude', state: 'idle', draft } as Hosted['harness'], ...over });
  it('says that messages or tasks wait for the unsent line, and nothing otherwise', () => {
    expect(heldNote(session(true, { unread: 1 }))).toBe('held: you have an unsent line here');
    expect(heldNote(session(true, { openTasks: 2 }))).toBe('held: you have an unsent line here');
    // Nothing waits, no draft, or the session has ended
    expect(heldNote(session(true))).toBe('');
    expect(heldNote(session(false, { unread: 1 }))).toBe('');
    expect(heldNote(session(true, { unread: 1, exit: { code: 0, signal: null, at: 1 } }))).toBe('');
    expect(heldNote(hosted({ unread: 1 }))).toBe('');
  });
});

describe('pointerSpans (MCR-106)', () => {
  const row = (text: string) => [...text].flatMap(c => c.charCodeAt(0) > 0x2e80 ? [{ chars: c, width: 2 }, { chars: '', width: 0 }] : [{ chars: c, width: 1 }]);
  const live = (id: string) => id === 'a27f56d8749b';
  it('gives a pointer its cells, also after wide characters and across a wrapped row', () => {
    expect(pointerSpans([row('go mcr:a27f56d8749b')], live)).toEqual([{ id: 'a27f56d8749b', text: 'mcr:a27f56d8749b', cells: [{ row: 0, x: 3, width: 16 }] }]);
    expect(pointerSpans([row('日本 mcr:a27f56d8749b')], live)[0].cells).toEqual([{ row: 0, x: 5, width: 16 }]);
    expect(pointerSpans([row('see: mcr:a27f'), row('56d8749b ok')], live)[0].cells).toEqual([{ row: 0, x: 5, width: 8 }, { row: 1, x: 0, width: 8 }]);
  });
  it('finds nothing for an unknown id, a bare id, or an empty cell inside a pointer', () => {
    expect(pointerSpans([row('mcr:000000000000 a27f56d8749b')], live)).toEqual([]);
    const gap = row('mcr:a27f56d8749b');
    gap[6] = { chars: '', width: 1 };
    expect(pointerSpans([gap], live)).toEqual([]);
  });
});

describe('folders the Live list leaves out (MCR-107)', () => {
  it('tells an agent\'s temporary folder from its path, on every system', () => {
    for (const path of ['/private/tmp/claude-501/-Users-me/abc/scratchpad', '/tmp/x', '/private/tmp/claude-501/x/scratchpad/trust-claude-1', '/var/folders/rh/T/mcr-store-1', '/private/var/folders/rh/T/x',
      '/Users/me/work/agent-mcr/.claude/live-check', '/Users/me/work/agent-mcr/.claude/live-check/hooks', '/Users/me/work/agent-mcr/.claude/live-check/inner',
      'C:\\Users\\Me\\AppData\\Local\\Temp\\scratch', 'c:/users/me/appdata/local/temp', 'C:\\Windows\\Temp\\x', 'C:\\Users\\Me\\work\\.claude\\live-check\\inner']) {
      expect(temporaryFolder(path), path).toBe(true);
    }
    for (const path of ['/Users/me/work/agent-mcr', '/Users/me/tmp', '/Users/me/tmpfoo', '/tmpx/y', '/Users/me/work/agent-mcr/.claude/worktrees/mcr-49', '/Users/me/.claude/live-checks', 'C:\\Users\\Me\\work', 'D:\\Temp\\project']) {
      expect(temporaryFolder(path), path).toBe(false);
    }
  });

  const live = { ...hosted(), cwd: '/tmp/x', exit: null };
  const over = { ...hosted(), cwd: '/tmp/x', exit: { code: 0, signal: null, at: 1 } };
  const section = (path: string, more: Partial<DirSection> = {}): DirSection => ({ path, sessions: [], earlier: [], pinned: false, latest: 0, ...more });
  const view = (sections: DirSection[], prefs = DEFAULT_LIVE_LIST) => {
    const v = folderVisibility(sections, prefs);
    return { shown: v.shown.map(d => d.path), hidden: v.hidden.map(h => [h.section.path, h.reason]) };
  };

  it('always shows a folder with a running session, whatever was chosen', () => {
    const prefs = { ...DEFAULT_LIVE_LIST, hiddenFolders: ['/tmp/x'] };
    expect(view([section('/tmp/x', { sessions: [live], earlier: [{ agent: 'claude', id: 'a', cwd: '/tmp/x', modified: 1, gone: true }] })], prefs)).toEqual({ shown: ['/tmp/x'], hidden: [] });
    expect(view([section('/tmp/x', { sessions: [over] })], prefs)).toEqual({ shown: [], hidden: [['/tmp/x', 'hidden']] });
  });

  it('says why a folder is out: hidden by the person first, then gone, then temporary', () => {
    const r = (cwd: string, more = {}) => ({ agent: 'claude' as const, id: cwd, cwd, modified: 1, ...more });
    const all = [
      section('/Users/me/a', { earlier: [r('/Users/me/a')] }),
      section('/Users/me/gone', { earlier: [r('/Users/me/gone', { gone: true })] }),
      section('/Users/me/removed', { sessions: [{ ...over, cwd: '/Users/me/removed', cwdGone: true }] }),
      section('/private/tmp/s/scratchpad', { earlier: [r('/private/tmp/s/scratchpad')] }),
      section('/private/tmp/mine', { earlier: [r('/private/tmp/mine', { gone: true })] }),
    ];
    expect(view(all, { ...DEFAULT_LIVE_LIST, hiddenFolders: ['/private/tmp/mine'] }).hidden.sort()).toEqual([
      ['/Users/me/gone', 'gone'], ['/Users/me/removed', 'gone'], ['/private/tmp/mine', 'hidden'], ['/private/tmp/s/scratchpad', 'temporary'],
    ]);
    // The switch off: only what the person hid
    expect(view(all, { ...DEFAULT_LIVE_LIST, hideNoise: false, hiddenFolders: ['/private/tmp/mine'] }).hidden).toEqual([['/private/tmp/mine', 'hidden']]);
    // Shown again by the person, or added by them: the rule does not take it back
    expect(view(all, { ...DEFAULT_LIVE_LIST, shownFolders: ['/Users/me/gone'] }).shown).toContain('/Users/me/gone');
    expect(view([section('/tmp/added', { pinned: true })]).shown).toEqual(['/tmp/added']);
  });

  it('hides past sessions by id, counts them, and puts a folder that has nothing else into the hidden entry', () => {
    const earlier = [{ agent: 'claude' as const, id: 's1', cwd: '/Users/me/a', modified: 2 }, { agent: 'claude' as const, id: 's2', cwd: '/Users/me/a', modified: 1 }];
    const v = folderVisibility([section('/Users/me/a', { earlier })], { ...DEFAULT_LIVE_LIST, hiddenSessions: ['s1'] });
    expect([v.shown[0].earlier.map(r => r.id), v.shown[0].hiddenEarlier]).toEqual([['s2'], 1]);
    expect(view([section('/Users/me/a', { earlier })], { ...DEFAULT_LIVE_LIST, hiddenSessions: ['s1', 's2'] }).hidden).toEqual([['/Users/me/a', 'sessions hidden']]);
    // A parent folder hides nothing below it: by exact path only
    expect(view([section('/Users/me'), section('/Users/me/a', { earlier })], { ...DEFAULT_LIVE_LIST, hiddenFolders: ['/Users/me'] }).shown).toEqual(['/Users/me/a']);
  });
});

describe('the Live list choices as stored (MCR-107)', () => {
  it('keeps lists of strings and a switch, and drops anything else', () => {
    expect(normalizeLiveList(undefined)).toEqual(DEFAULT_LIVE_LIST);
    expect(normalizeLiveList('rubbish')).toEqual(DEFAULT_LIVE_LIST);
    expect(normalizeLiveList({ hiddenFolders: ['/a', 7, null, { x: 1 }], shownFolders: 'not a list', hiddenSessions: [['nested']], hideNoise: 'yes' }))
      .toEqual({ hiddenFolders: ['/a'], shownFolders: [], hiddenSessions: [], hideNoise: true });
    expect(normalizeLiveList({ hideNoise: false }).hideNoise).toBe(false);
  });
});

describe('runningFor', () => {
  it('says how long, and nothing for a missing start time', () => {
    expect(runningFor(0, 125 * 60_000)).toBe('2h 5m');
    expect(runningFor(0, 59_000)).toBe('59s');
    expect(runningFor(Number.NaN, 1)).toBe('');
    expect(runningFor(undefined as unknown as number, 1)).toBe('');
  });
});

describe('programHint (MCR-115)', () => {
  const now = Date.now();
  const hooks = (state: 'working' | 'idle' | 'waiting') => ({ name: '', profile: 'claude', state, precise: true, hooked: true } as Hosted['harness']);
  it('shows the root record, else the one updated last, as the program\'s word', () => {
    const h = hosted({ program: { records: [
      { id: 'lint', state: 'done', at: now - 5000 },
      { state: 'working', progress: 40, app: 'cargo', title: 'cargo build', at: now - 1000 },
      { id: 'deploy', state: 'blocked', kind: 'permission', msg: 'Approve deploy?', at: now },
    ] } });
    const hint = programHint(h)!;
    expect(hint.lead).toBe('program cargo');
    expect(hint.text).toBe('working 40% · cargo build · +2 more');
    expect(hint.progress).toBe(40);
    // The tooltip says where it comes from and that nothing checked it, then every record, newest first
    expect(hint.full).toContain('Not checked: any output can print this');
    expect(hint.full.split('\n').slice(-3).map(l => l.split(':')[0])).toEqual(['deploy', '(root)', 'lint']);
    const noRoot = programHint(hosted({ program: { records: [{ id: 'a', state: 'done', at: now - 9 }, { id: 'b', state: 'error', msg: 'tests failed', app: 'npm', at: now }] } }))!;
    expect([noRoot.lead, noRoot.text, noRoot.progress]).toEqual(['program npm', 'error · tests failed · +1 more', undefined]);
  });

  it('ranks below the hooks: a forged report never changes the state, and says that the hooks differ', () => {
    // Output printed "blocked on a permission" while the hooks say the agent works
    const h = hosted({ harness: hooks('working'), program: { records: [{ state: 'blocked', kind: 'permission', msg: 'Approve rm -rf?', at: now }] } });
    expect(hostedState(h)).toBe('working');
    const hint = programHint(h)!;
    expect(hint.disagrees).toBe(true);
    expect(hint.full).toContain("The agent's hooks say working, and the hooks rank first.");
    expect(hint.text).toBe('blocked (permission) · Approve rm -rf?');
    // Where they agree, nothing is struck
    expect(programHint(hosted({ harness: hooks('waiting'), program: h.program }))!.disagrees).toBe(false);
    expect(programHint(hosted({ harness: hooks('working'), program: { records: [{ state: 'working', at: now }] } }))!.disagrees).toBe(false);
    // Without hooks there is nothing to disagree with
    expect(programHint(hosted({ program: h.program }))!.disagrees).toBe(false);
  });

  it('falls back to OSC 9;4 progress, then to the OSC 133 mark', () => {
    expect(programHint(hosted({ program: { progress: { state: 'normal', value: 30, at: now } } }))).toMatchObject({ lead: 'program', text: 'progress 30%', progress: 30 });
    expect(programHint(hosted({ program: { progress: { state: 'indeterminate', at: now } } }))).toMatchObject({ text: 'busy', progress: undefined });
    expect(programHint(hosted({ program: { progress: { state: 'error', value: 80, at: now } } }))!.text).toBe('error 80%');
    expect(programHint(hosted({ program: { prompt: { mark: 'D', exit: 2, at: now } } }))).toMatchObject({ lead: 'shell', text: 'command finished with 2' });
    expect(programHint(hosted({ program: { prompt: { mark: 'A', at: now } } }))!.text).toBe('at a prompt');
    // A 7501 record outranks both
    expect(programHint(hosted({ program: { records: [{ state: 'idle', at: now }], progress: { state: 'normal', value: 3, at: now } } }))!.text).toBe('idle');
  });

  it('says nothing when the program said nothing, or the session ended', () => {
    expect(programHint(hosted())).toBeNull();
    expect(programHint(hosted({ program: {} }))).toBeNull();
    expect(programHint(hosted({ program: { records: [{ state: 'done', at: now }] }, exit: { code: 0, signal: null, at: now } }))).toBeNull();
  });
});

describe('agentProfileTitle', () => {
  it('says what a profile is and how it runs, leaving out what it does not set', () => {
    expect(agentProfileTitle({ id: 'implementer@claude-opus', version: 1, role: 'implementer', adapter: 'claude', summary: 'Builds one issue', model: 'opus', effort: 'high', mode: 'acceptEdits' }))
      .toBe('Builds one issue (v1; model opus, effort high, mode acceptEdits)');
    expect(agentProfileTitle({ id: 'lead@codex', version: 2, role: 'lead', adapter: 'codex', summary: '', model: null, effort: 'high', mode: 'workspace-write' }))
      .toBe('lead@codex (v2; effort high, mode workspace-write)');
    expect(agentProfileTitle({ id: 'custom@pi', version: 1, role: 'custom', adapter: 'pi', summary: 'Pi' })).toBe('Pi (v1)');
  });
});
