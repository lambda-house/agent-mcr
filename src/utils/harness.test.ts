import { describe, expect, it } from 'vitest';
import { gist, hostedLabel, hostedState, pastedImage, sessionReference, sessionSummary, shellQuote, type Hosted } from './harness';

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
