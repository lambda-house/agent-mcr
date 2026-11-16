// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import HarnessSettingsSection from './HarnessSettingsSection';
import { harnessApi, type HarnessPreferences } from '../utils/harness';

vi.mock('../utils/harness', () => ({ harnessApi: { status: vi.fn(), preferences: vi.fn(), savePreferences: vi.fn(), outsideSupervisors: vi.fn() } }));
const prefs: HarnessPreferences = {
  profiles: ['claude', 'codex', 'antigravity', 'pi', 'opencode', 'shell'].map(id => ({ id, label: id === 'shell' ? 'Terminal' : id, command: id === 'shell' ? '' : id, optional: ['antigravity', 'pi', 'opencode'].includes(id), canSupervise: id !== 'shell', taskTracking: ['claude', 'codex'].includes(id) })),
  enabledProfiles: ['claude', 'shell'], supervisorProfile: 'claude',
};
let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const toggle = (id: string) => host.querySelector(`input[aria-label="Enable ${id}"]`) as HTMLInputElement;
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(harnessApi.status).mockResolvedValue({ runner: { protocol: 1, pid: 7, version: '0.1.0', exe: '/x' }, profiles: prefs.profiles, home: '/Users/me' });
  vi.mocked(harnessApi.preferences).mockResolvedValue(prefs);
  vi.mocked(harnessApi.savePreferences).mockImplementation(async next => ({ ...prefs, ...next }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('enables Pi and OpenCode and allows either to supervise', async () => {
  await act(async () => root.render(<HarnessSettingsSection/>)); await flush();
  const select = host.querySelector('select') as HTMLSelectElement;
  expect([...select.options].map(o => o.value)).toEqual(['', 'claude']);
  for (const id of ['pi', 'opencode']) {
    await act(async () => toggle(id).click()); await flush();
    expect([...select.options].map(o => o.value)).toContain(id);
    await act(async () => { select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(harnessApi.savePreferences).toHaveBeenLastCalledWith({ enabledProfiles: expect.arrayContaining([id, 'shell']), supervisorProfile: id });
  }
  expect([...select.options].map(o => o.value)).not.toContain('shell');
});

it('clears supervisor when its harness is disabled and retains state if saving fails', async () => {
  await act(async () => root.render(<HarnessSettingsSection/>)); await flush();
  await act(async () => toggle('claude').click()); await flush();
  expect(harnessApi.savePreferences).toHaveBeenLastCalledWith({ enabledProfiles: ['shell'], supervisorProfile: null });
  expect((host.querySelector('select') as HTMLSelectElement).value).toBe('');
  vi.mocked(harnessApi.savePreferences).mockRejectedValue(new Error('Disk is full'));
  await act(async () => toggle('pi').click()); await flush();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Disk is full');
  expect(toggle('pi').checked).toBe(false);
});

it('shows preference load failures', async () => {
  vi.mocked(harnessApi.preferences).mockRejectedValue('Cannot read preferences');
  await act(async () => root.render(<HarnessSettingsSection/>)); await flush();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Cannot read preferences');
  expect(host.querySelector('input')).toBeNull();
});

it('uses adapter capabilities for supervisor choices and labels optional plugins', async () => {
  const pi = prefs.profiles.find(p => p.id === 'pi')!;
  vi.mocked(harnessApi.preferences).mockResolvedValue({
    profiles: [{ ...pi, canSupervise: false }, prefs.profiles.find(p => p.id === 'claude')!],
    enabledProfiles: ['pi', 'claude'], supervisorProfile: 'claude',
  });
  await act(async () => root.render(<HarnessSettingsSection/>)); await flush();
  expect(host.textContent).toContain('Optional plugin · pi');
  expect(host.textContent).toContain('Built in · claude');
  expect([...(host.querySelector('select') as HTMLSelectElement).options].map(o => o.value)).toEqual(['', 'claude']);
});
