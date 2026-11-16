// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import SessionMetrics, { useSessionMetrics } from './SessionMetrics';
import { sessionApi, type Session } from '../utils/sessions';
import type { Hosted } from '../utils/harness';
import { estimatedCost } from '../utils/sessionCost';
vi.mock('../utils/sessions', async original => ({ ...await original<object>(), sessionApi: { snapshot: vi.fn() } }));
const usage = { input: 1_000_000, cached: 600_000, cacheWrite: 100_000, output: 10_000, reasoning: 5000 };
const session = { id: 's1', provider: 'claude', modified: Date.now(), usageKnown: true, models: { 'claude-opus-4-6': usage }, context: { now: 180_000, window: 200_000, compactions: 2 } } as unknown as Session;
const hosted = { meta: { profile: 'claude' }, harness: { agentSession: 's1' } } as unknown as Hosted;
it('estimates cached input once, includes output once, and refuses partial model costs', () => {
  expect(estimatedCost(session)).toBeCloseTo(2.675);
  expect(estimatedCost({ ...session, models: { ...session.models, unknown: usage } })).toBeNull();
  expect(estimatedCost({ ...session, provider: 'codex' })).toBeNull();
  expect(estimatedCost({ ...session, usageKnown: false })).toBeNull();
});
it('shows context, observed compactions, costs, unknown limits and missing telemetry', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<SessionMetrics hosted={hosted} data={{ 'claude:s1': session }}/>));
    expect(host.textContent).toContain('Context 90%');
    expect(host.textContent).toContain('≈ $2.67');
    expect(host.textContent).toContain('2 comp.');
    expect(host.querySelector('.high')).not.toBeNull();
    await act(async () => root.render(<SessionMetrics hosted={hosted} data={{ 'claude:s1': { ...session, modified: 1, context: { ...session.context!, window: 0 } } }}/>));
    expect(host.textContent).toContain('180K tok · old');
    expect(host.querySelector('.hs-metric-bar')).toBeNull();
    await act(async () => root.render(<SessionMetrics hosted={hosted} data={{}}/>));
    expect(host.textContent).toContain('Context —');
    expect(host.textContent).toContain('Cost —');
    expect(host.textContent).toContain('— comp.');
  } finally { await act(async () => root.unmount()); }
});
it('does not overlap scans and clears values after access/read failure', async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); const root = createRoot(host);
  function Probe() { const data = useSessionMetrics(true); return <span>{Object.keys(data).length}</span>; }
  let resolve!: (v: any) => void;
  vi.mocked(sessionApi.snapshot).mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockRejectedValue(new Error('access revoked'));
  try {
    await act(async () => root.render(<Probe/>));
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(sessionApi.snapshot).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ sessions: [session] }));
    expect(host.textContent).toBe('1');
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(host.textContent).toBe('0');
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
});
