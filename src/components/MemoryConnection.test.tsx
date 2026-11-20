// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MemoryConnection from './MemoryConnection';
import { memoryApi, memoryStateLine, type MemoryStatus } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({
  ...await importOriginal<object>(),
  memoryApi: { status: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
}));
const base: MemoryStatus = { state: 'disconnected', endpoint: 'https://mcp.memory.teob.cc/mcp', since: 0, defaultMemory: 'mcr-agents', problem: null };
let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const button = () => host.querySelector('button') as HTMLButtonElement;
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it('offers to connect, then follows the sign-in until it is over', async () => {
  vi.mocked(memoryApi.status).mockResolvedValue(base);
  vi.mocked(memoryApi.connect).mockResolvedValue({ ...base, state: 'connecting' });
  await act(async () => root.render(<MemoryConnection/>)); await flush();
  expect(host.textContent).toContain('Not connected');
  expect(button().textContent).toBe('Connect…');
  vi.useFakeTimers();
  await act(async () => button().click());
  await act(async () => { await Promise.resolve(); });
  expect(button().textContent).toBe('Cancel sign-in');
  expect(host.textContent).toContain('Waiting for the sign-in in your browser');
  // The browser finished: the next look at the service shows it
  vi.mocked(memoryApi.status).mockResolvedValue({ ...base, state: 'connected', since: 5 });
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(button().textContent).toBe('Disconnect…');
  expect(host.textContent).toContain('a call that names no memory goes to mcr-agents');
  // Connected: nothing is asked again and again
  const asked = vi.mocked(memoryApi.status).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(vi.mocked(memoryApi.status).mock.calls.length).toBe(asked);
});

it('shows what went wrong and lets the person sign in again', async () => {
  vi.mocked(memoryApi.status).mockResolvedValue({ ...base, state: 'signed_out', problem: { kind: 'signed_out', text: 'The sign-in is no longer valid.', at: 1 } });
  vi.mocked(memoryApi.connect).mockRejectedValue('The browser could not be opened');
  await act(async () => root.render(<MemoryConnection/>)); await flush();
  expect(button().textContent).toBe('Sign in again…');
  expect(host.textContent).toContain('Last problem');
  await act(async () => button().click()); await flush();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('The browser could not be opened');
  expect(button().disabled).toBe(false);
});

it('says in one line where the connection stands', () => {
  expect(memoryStateLine({ ...base, state: 'connected' })).toContain('Connected to https://mcp.memory.teob.cc/mcp');
  expect(memoryStateLine(base)).toContain('tells them so');
});
