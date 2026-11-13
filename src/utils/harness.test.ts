import { describe, expect, it } from 'vitest';
import { hostedLabel, hostedState, pastedImage, shellQuote, type Hosted } from './harness';

const hosted = (over: Partial<Hosted> = {}): Hosted => ({ id: 'a', pid: 1, argv: ['/bin/zsh', '-l', '-i', '-c', 'exec codex'], cwd: '/w', started: 0, cols: 80, rows: 24, title: '', lastOutput: 0, exit: null, meta: {}, ...over });

function transfer(items: { kind: string; type: string }[]): DataTransfer {
  const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
  return { items: items.map(i => ({ ...i, getAsFile: () => (i.kind === 'file' ? file : null) })) } as unknown as DataTransfer;
}

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
  });
});
