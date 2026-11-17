import { describe, expect, it } from 'vitest';
import { gist, hostedLabel, hostedState, pastedImage, sessionReference, sessionSummary, shellQuote, type Hosted, relationRows, executorsBelow } from './harness';

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
