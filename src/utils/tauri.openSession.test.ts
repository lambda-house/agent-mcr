// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, () => void>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: () => void) => { native.listeners.set(name, handler); return () => native.listeners.delete(name); }) }));
import { onOpenSession } from './tauri';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('a clicked banner reaches the page (MCR-180)', () => {
  beforeEach(() => { native.invoke.mockReset(); native.listeners.clear(); Object.assign(window, { __TAURI_INTERNALS__: {} }); });
  afterEach(() => { delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });

  it('takes a click that came before it listened, once it listens', async () => {
    native.invoke.mockResolvedValueOnce({ session: 's1', at: 1 });
    const opened = vi.fn();
    await onOpenSession(opened); await flush();
    expect(native.invoke).toHaveBeenCalledWith('harness_open_session_take');
    expect(opened).toHaveBeenCalledWith('s1');
  });

  it('takes the click at each event, and opens nothing when there is none left', async () => {
    native.invoke.mockResolvedValue(null);
    const opened = vi.fn();
    const stop = await onOpenSession(opened); await flush();
    expect(opened).not.toHaveBeenCalled();
    native.invoke.mockResolvedValueOnce({ session: 's2', at: 2 });
    native.listeners.get('harness-open-session')!(); await flush();
    expect(opened.mock.calls).toEqual([['s2']]);
    // Another event for a click already taken (null) opens nothing more
    native.listeners.get('harness-open-session')!(); await flush();
    expect(opened).toHaveBeenCalledTimes(1);
    // A click about no session reaches the page too, to take back the ask it took (round 4)
    native.invoke.mockResolvedValueOnce({ session: null, at: 3 });
    native.listeners.get('harness-open-session')!(); await flush();
    expect(opened.mock.calls).toEqual([['s2'], [null]]);
    // Two takes on their way, the newer reply first: the older one is stale and dropped (round 6)
    let older!: (c: unknown) => void;
    native.invoke.mockReturnValueOnce(new Promise(resolve => { older = resolve; }));
    native.listeners.get('harness-open-session')!(); await flush();
    native.invoke.mockResolvedValueOnce({ session: null, at: 5 });
    native.listeners.get('harness-open-session')!(); await flush();
    older({ session: 's4', at: 4 }); await flush();
    expect(opened.mock.calls).toEqual([['s2'], [null], [null]]);
    stop();
    expect(native.listeners.has('harness-open-session')).toBe(false);
  });
});
