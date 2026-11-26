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
    native.invoke.mockResolvedValueOnce({ session: 's1' });
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
    native.invoke.mockResolvedValueOnce({ session: 's2' });
    native.listeners.get('harness-open-session')!(); await flush();
    expect(opened.mock.calls).toEqual([['s2']]);
    // Another event for a click already taken (null) opens nothing more
    native.listeners.get('harness-open-session')!(); await flush();
    expect(opened).toHaveBeenCalledTimes(1);
    // A click about no session reaches the page too, to take back the ask it took (round 4)
    native.invoke.mockResolvedValueOnce({ session: null });
    native.listeners.get('harness-open-session')!(); await flush();
    expect(opened.mock.calls).toEqual([['s2'], [null]]);
    stop();
    expect(native.listeners.has('harness-open-session')).toBe(false);
  });
});
