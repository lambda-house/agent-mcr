// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionStats from './SessionStats';
import { sessionApi, type Session } from '../utils/sessions';
import type { Hosted } from '../utils/harness';

vi.mock('../utils/sessions', async importOriginal => ({ ...await importOriginal<object>(), sessionApi: { stats: vi.fn() } }));

const hosted = (profile: string, agentSession: string | null): Hosted => ({
  id: 'h1', pid: 1, argv: [], cwd: '/work/repo', started: 1, cols: 80, rows: 24, title: '', lastOutput: 1, exit: null, meta: { profile },
  harness: { name: '', profile, state: 'idle', since: 1, precise: true, agentSession, attention: null, lastMessage: null },
});
const indexed = {
  provider: 'claude', id: 'c1', usageKnown: true, usage: { input: 2_000_000, cached: 1_500_000, cacheWrite: 80_000, output: 40_000, reasoning: 0 },
  models: { opus: { input: 2_000_000, cached: 0, cacheWrite: 0, output: 40_000, reasoning: 0 } }, tools: { Bash: 30, Read: 12, Skill: 1 },
  context: { now: 120_000, first: 30_000, peak: 150_000, window: 0, compactions: 2, toolBytes: { Read: 900_000, Bash: 40_000 }, skills: { deploy: 1 } },
} as unknown as Session;

let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Session usage pane', () => {
  it('shows context, tokens, tools by what they returned, and skills', async () => {
    vi.mocked(sessionApi.stats).mockResolvedValue(indexed);
    await act(async () => root.render(<SessionStats session={hosted('claude', 'c1')} active/>)); await flush();
    expect(sessionApi.stats).toHaveBeenCalledWith('claude', 'c1');
    // Claude records no limit: 200K is assumed and marked
    expect(host.querySelector('.hs-stats-big')?.textContent).toBe('120K of ~200K · 60%');
    expect(host.querySelector('.hs-cache-warm, .hs-cache-cold')).toBeNull();
    const text = host.textContent ?? '';
    expect(text).toContain('At start30K');
    expect(text).toContain('Compactions2');
    expect(text).toContain('from cache1.5M · 75%');
    // The tool that put most into the context comes first, whatever its call count
    const rows = [...host.querySelectorAll('section:nth-of-type(3) li')].map(li => li.textContent);
    expect(rows).toEqual(['Read12879 KB', 'Bash3039 KB', 'Skill10 B']);
    expect(text).toContain('deploy1');
  });

  it('shows whether the cache is warm, and what cold wakeups cost so far', async () => {
    const withCache = (cacheAt: number) => ({ ...indexed, context: { ...indexed.context!, peak: 250_000, cacheTtl: 3600, cacheAt, coldWakeups: 3, coldTokens: 400_000 } });
    vi.mocked(sessionApi.stats).mockResolvedValue(withCache(Date.now() - 20 * 60_000));
    await act(async () => root.render(<SessionStats session={hosted('claude', 'c1')} active/>)); await flush();
    // Past 200K the session can only be on the long window
    expect(host.querySelector('.hs-stats-big')?.textContent).toBe('120K of ~1M · 12%');
    const warm = host.querySelector('.hs-cache-warm')?.textContent ?? '';
    expect(warm).toMatch(/Warm · (39|40)m left/);
    expect(warm).toContain('Lifetime1 h');
    expect(warm).toContain('Cold wakeups3');
    expect(warm).toContain('read uncached400K · 20%');
    await act(async () => root.unmount()); root = createRoot(host);
    vi.mocked(sessionApi.stats).mockResolvedValue(withCache(Date.now() - 3 * 3600_000));
    await act(async () => root.render(<SessionStats session={hosted('claude', 'c1')} active/>)); await flush();
    const cold = host.querySelector('.hs-cache-cold')?.textContent ?? '';
    expect(cold).toContain('Cold · for 2h 0m');
    expect(cold).toContain('writes about 120K tokens to the cache again');
  });

  it('says why there is nothing to show', async () => {
    vi.mocked(sessionApi.stats).mockRejectedValue('Enable session access first');
    await act(async () => root.render(<SessionStats session={hosted('codex', 't1')} active/>)); await flush();
    expect(host.textContent).toContain('Turn on session access');
    await act(async () => root.render(<SessionStats session={hosted('claude', null)} active/>)); await flush();
    expect(host.textContent).toContain('No conversation yet');
    await act(async () => root.render(<SessionStats session={hosted('shell', null)} active/>)); await flush();
    expect(host.textContent).toContain('A shell has no usage');
  });
});
