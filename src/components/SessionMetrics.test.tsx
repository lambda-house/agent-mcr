// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import SessionMetrics, { cacheClass, useSessionMetrics } from './SessionMetrics';
import { sessionApi, type Session } from '../utils/sessions';
import type { Hosted } from '../utils/harness';
import { estimatedCost } from '../utils/sessionCost';
vi.mock('../utils/sessions', async original => ({ ...await original<object>(), sessionApi: { snapshot: vi.fn(), pick: vi.fn() } }));
const usage = { input: 1_000_000, cached: 600_000, cacheWrite: 100_000, output: 10_000, reasoning: 5000 };
const session = { id: 's1', provider: 'claude', modified: Date.now(), usageKnown: true, usage, models: { 'claude-opus-4-6': usage }, context: { now: 180_000, window: 200_000, compactions: 2 } } as unknown as Session;
const hosted = { meta: { profile: 'claude' }, harness: { agentSession: 's1' } } as unknown as Hosted;
it('estimates cached input once, includes output once, and refuses partial model costs', () => {
  expect(estimatedCost(session)).toBeCloseTo(2.675);
  expect(estimatedCost({ ...session, models: { ...session.models, unknown: usage } })).toBeNull();
  expect(estimatedCost({ ...session, provider: 'codex' })).toBeNull();
  expect(estimatedCost({ ...session, usageKnown: false })).toBeNull();
});
it('shows bare figures and explains them in one tooltip', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); const root = createRoot(host);
  const title = () => host.querySelector('.hs-metrics')?.getAttribute('title') ?? '';
  try {
    await act(async () => root.render(<SessionMetrics hosted={hosted} data={{ 'claude:s1': session }}/>));
    expect(host.textContent).toBe('90%180K↻ 2$2.67');
    expect(host.querySelector('.high')).not.toBeNull();
    expect(title()).toContain('Context: 180K of 200K tokens (90%)');
    expect(title()).not.toContain('assumed');
    expect(title()).toContain('Compactions: 2');
    expect(title()).toContain('Lifetime tokens: 1M in (600K cached) · 10K out');
    expect(title()).toContain('Cost: ≈ $2.67');
    // No recorded limit (Claude): 200K is assumed and marked, 1M once the session has held more
    const unrecorded = (now: number, extra: object = {}) => ({ 'claude:s1': { ...session, modified: 1, context: { ...session.context!, now, peak: now, window: 0, compactions: 0, ...extra } } });
    await act(async () => root.render(<SessionMetrics hosted={hosted} data={unrecorded(180_000)}/>));
    expect(host.textContent).toBe('~90%180K$2.67');
    expect(title()).toContain('the limit is assumed');
    expect(title()).toContain('may be old');
    await act(async () => root.render(<SessionMetrics hosted={hosted} data={unrecorded(418_000)}/>));
    expect(host.textContent).toBe('~42%418K$2.67');
    expect(host.querySelector('.high')).toBeNull();
    // The cache: time left while warm, "cold" after its lifetime, with what waking up costs
    await act(async () => root.render(<SessionMetrics hosted={hosted} data={unrecorded(180_000, { cacheTtl: 3600, cacheAt: Date.now() - 18 * 60_000 })}/>));
    expect(host.querySelector('.hs-metric-cache')?.textContent).toMatch(/^4[12]m$/);
    expect(cacheClass(hosted, unrecorded(180_000, { cacheTtl: 3600, cacheAt: Date.now() - 18 * 60_000 }), Date.now())).toBe('cache-warm');
    expect(cacheClass(hosted, unrecorded(180_000, { cacheTtl: 3600, cacheAt: Date.now() - 55 * 60_000 }), Date.now())).toBe('cache-warm cache-cooling');
    const cold = unrecorded(180_000, { cacheTtl: 300, cacheAt: Date.now() - 3600_000, coldWakeups: 2, coldTokens: 300_000 });
    await act(async () => root.render(<SessionMetrics hosted={hosted} data={cold}/>));
    expect(host.querySelector('.hs-metric-cache.cold')?.textContent).toBe('cold');
    expect(title()).toContain('Waking the session up writes about 180K tokens to the cache again');
    expect(title()).toContain('Cold wakeups so far: 2 · 300K tokens read uncached');
    expect(cacheClass(hosted, cold, Date.now())).toBe('cache-cold');
    // At work it is being refreshed, whatever the index last saw; an ended one has no cache to keep
    expect(cacheClass({ ...hosted, harness: { ...hosted.harness!, state: 'working' } }, cold, Date.now())).toBe('cache-warm');
    expect(cacheClass({ ...hosted, exit: { code: 0, signal: null, at: 1 } }, cold, Date.now())).toBe('');
    await act(async () => root.render(<SessionMetrics hosted={hosted} data={{}}/>));
    expect(host.textContent).toBe('');
  } finally { await act(async () => root.unmount()); }
});
it('does not overlap scans and clears values after access/read failure', async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); const root = createRoot(host);
  function Probe() { const data = useSessionMetrics(true, [hosted]); return <span>{Object.keys(data).length}</span>; }
  let resolve!: (v: any) => void;
  vi.mocked(sessionApi.pick).mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockRejectedValue(new Error('access revoked'));
  try {
    await act(async () => root.render(<Probe/>));
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(sessionApi.pick).toHaveBeenCalledTimes(1);
    await act(async () => resolve([session]));
    expect(host.textContent).toBe('1');
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(host.textContent).toBe('0');
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
});
it('asks the index for the hosted conversations only, and for a new one as soon as it runs (MCR-139)', async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); const root = createRoot(host);
  const shell = { meta: { profile: 'shell' }, harness: { agentSession: '' } } as unknown as Hosted;
  const ended = { meta: { profile: 'codex' }, harness: { agentSession: 'old' }, exit: { code: 0 } } as unknown as Hosted;
  const codex = { meta: { profile: 'codex' }, harness: { profile: 'codex', agentSession: 'c1' } } as unknown as Hosted;
  function Probe({ list }: { list: Hosted[] }) { const data = useSessionMetrics(true, list); return <span>{Object.keys(data).join(',')}</span>; }
  vi.mocked(sessionApi.snapshot).mockReset();
  vi.mocked(sessionApi.pick).mockReset().mockImplementation(keys => Promise.resolve(keys.includes('claude:s1') ? [session] : []));
  try {
    await act(async () => root.render(<Probe list={[shell, ended, hosted]}/>));
    expect(vi.mocked(sessionApi.pick).mock.calls).toEqual([[['claude:s1']]]);
    expect(host.textContent).toBe('claude:s1');
    await act(async () => root.render(<Probe list={[shell, ended, hosted, codex]}/>));
    expect(vi.mocked(sessionApi.pick).mock.lastCall).toEqual([['claude:s1', 'codex:c1']]);
    // Unchanged answers set nothing new; the whole index is never asked for
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(sessionApi.snapshot).not.toHaveBeenCalled();
    expect(host.textContent).toBe('claude:s1');
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
});
