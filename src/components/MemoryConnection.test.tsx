// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MemoryConnection from './MemoryConnection';
import { memoryApi, memoryStateLine, vaultApi, type MemoryStatus } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({
  ...await importOriginal<object>(),
  memoryApi: { status: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
  vaultApi: { unlock: vi.fn() },
}));
// The keyring the app can unlock is Linux's
vi.mock('../utils/platform', async importOriginal => ({ ...await importOriginal<object>(), PLATFORM: 'linux' }));
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

it('offers to unlock the keyring that holds the sign-in back, and says why an unlock failed', async () => {
  const locked = { kind: 'vault_unavailable', text: "Memory's sign-in could not be read from the secret store: the keyring is locked.", at: 7 };
  vi.mocked(memoryApi.status).mockResolvedValue({ ...base, state: 'connected', since: 5, problem: locked });
  vi.mocked(vaultApi.unlock).mockRejectedValueOnce('The keyring could not be unlocked: the unlock was cancelled').mockResolvedValueOnce(undefined);
  await act(async () => root.render(<MemoryConnection/>)); await flush();
  expect(host.textContent).toContain('the sign-in stays in your desktop keyring and Agent MCR gives it to no agent');
  const unlock = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Unlock keyring…');
  await act(async () => unlock()!.click()); await flush();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('The keyring could not be unlocked: the unlock was cancelled');
  await act(async () => unlock()!.click()); await flush();
  expect(vaultApi.unlock).toHaveBeenCalledTimes(2);
  expect(unlock()).toBeUndefined();
  // The headline says it, once: no longer locked, and what sessions started meanwhile need
  const line = host.querySelector('[role="status"]')?.textContent ?? '';
  expect(line).toContain('The keyring is unlocked: memory is used again at its next call.');
  expect(line).toContain('Sessions started while it was locked have no memory tools until they are restarted or reconnected');
  expect(host.textContent).not.toContain('Memory cannot be used now');
  expect(host.textContent!.split('The keyring is unlocked').length).toBe(2);
  // The Last problem row stays as it was
  expect(host.textContent).toContain("Last problem");
  expect(host.textContent).toContain("could not be read from the secret store: the keyring is locked.");
});

it('says in the headline that a locked keyring leaves memory unusable while still signed in', async () => {
  const locked = { kind: 'vault_unavailable', text: "Memory's sign-in could not be read from the secret store: the keyring is locked.", at: 7 };
  vi.mocked(memoryApi.status).mockResolvedValue({ ...base, state: 'connected', since: 5, problem: locked });
  await act(async () => root.render(<MemoryConnection/>)); await flush();
  expect(host.textContent).toContain('Signed in to https://mcp.memory.teob.cc/mcp; no new sign-in is needed. Memory cannot be used now: the sign-in cannot be read from the secret store.');
  expect(host.textContent).not.toContain('New and restarted sessions have the memory tools');
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it('says that memory works while a renewed token could not be saved, and offers no unlock for it', async () => {
  const unsaved = { kind: 'vault_unsaved', text: 'Memory works and its calls go through, but the secret store could not save a renewed token (the keyring asked for a confirmation that was not given). Each call renews the sign-in until a save succeeds.', at: 7 };
  vi.mocked(memoryApi.status).mockResolvedValue({ ...base, state: 'connected', since: 5, problem: unsaved });
  await act(async () => root.render(<MemoryConnection/>)); await flush();
  expect(host.textContent).toContain('Memory works and new and restarted sessions have the memory tools, but the secret store could not save a renewed token');
  expect(host.textContent).not.toContain('Memory cannot be used now');
  expect(host.textContent).not.toContain('cannot be read from the secret store');
  expect(host.textContent).toContain('Each call renews the sign-in until a save succeeds.');
  expect(host.textContent).not.toContain('Unlock keyring');
});

it('offers no unlock for a problem that is not the keyring', async () => {
  vi.mocked(memoryApi.status).mockResolvedValue({ ...base, state: 'connected', since: 5, problem: { kind: 'unreachable', text: 'The memory service could not be reached: timed out', at: 3 } });
  await act(async () => root.render(<MemoryConnection/>)); await flush();
  expect(host.textContent).toContain('Last problem');
  expect(host.textContent).not.toContain('Unlock keyring');
});

it('says in one line where the connection stands', () => {
  expect(memoryStateLine({ ...base, state: 'connected' })).toBe('Connected to https://mcp.memory.teob.cc/mcp. New and restarted sessions have the memory tools; a call that names no memory goes to mcr-agents.');
  expect(memoryStateLine(base)).toContain('tells them so');
});

it('does not claim the memory tools while a problem leaves memory unusable', () => {
  const connected = { ...base, state: 'connected' as const, since: 5 };
  const why = { vault_unavailable: 'the sign-in cannot be read from the secret store', unreachable: 'the memory service cannot be reached', refused: 'the memory service refuses its calls' };
  for (const [kind, reason] of Object.entries(why)) {
    const line = memoryStateLine({ ...connected, problem: { kind, text: 'in the service words', at: 3 } });
    expect(line).toBe(`Signed in to https://mcp.memory.teob.cc/mcp; no new sign-in is needed. Memory cannot be used now: ${reason}. Sessions started meanwhile have no memory tools until they are restarted or reconnected (in Claude Code, /mcp and then reconnect mcr-memory).`);
    expect(line).not.toContain('have the memory tools;');
  }
  // An unlock is about the keyring only
  expect(memoryStateLine({ ...connected, problem: { kind: 'unreachable', text: '', at: 3 } }, true)).toContain('Memory cannot be used now: the memory service cannot be reached.');
  expect(memoryStateLine({ ...connected, problem: { kind: 'vault_unavailable', text: '', at: 3 } }, true)).toBe('Signed in to https://mcp.memory.teob.cc/mcp. The keyring is unlocked: memory is used again at its next call. Sessions started while it was locked have no memory tools until they are restarted or reconnected (in Claude Code, /mcp and then reconnect mcr-memory).');
  // No model key: the tools are listed and calls without a model work, so the headline stays; the Last problem row says the rest
  expect(memoryStateLine({ ...connected, problem: { kind: 'no_model_key', text: '', at: 3 } })).toContain('New and restarted sessions have the memory tools');
  // A token the store did not save leaves memory usable
  expect(memoryStateLine({ ...connected, problem: { kind: 'vault_unsaved', text: '', at: 3 } })).not.toContain('cannot be used now');
  // A sign-in the vault holds but cannot be used asks for a new Connect, not for patience
  const unusable = memoryStateLine({ ...connected, problem: { kind: 'sign_in_unusable', text: '', at: 3 } });
  expect(unusable).toContain('Disconnect and connect again');
  expect(unusable).not.toContain('no new sign-in is needed');
  // A problem left over from before a sign-out or disconnect does not change those lines
  expect(memoryStateLine({ ...base, state: 'signed_out', problem: { kind: 'unreachable', text: '', at: 3 } })).toContain('Sign in again');
});
