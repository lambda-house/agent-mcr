// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import HarnessSettingsSection from './HarnessSettingsSection';
import { harnessApi, type HarnessPreferences } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({
  ...await importOriginal<object>(),
  harnessApi: { status: vi.fn(), preferences: vi.fn(), savePreferences: vi.fn(), outsideSupervisors: vi.fn(), codexHooks: vi.fn(), programQuery: vi.fn(), background: vi.fn(), stopBackground: vi.fn() },
}));
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

it('turns Codex hooks on only when the native question was answered yes, and says where the trust step stands', async () => {
  await act(async () => root.render(<HarnessSettingsSection/>)); await flush();
  const box = () => host.querySelector('input[aria-label="Use Codex hooks"]') as HTMLInputElement;
  expect(box().checked).toBe(false);
  expect(host.textContent).toContain('Off: Agent MCR reads a Codex prompt from its terminal instead, as a guess.');
  // The person cancelled the native dialog: the command says the setting is still off
  vi.mocked(harnessApi.codexHooks).mockResolvedValue(false);
  await act(async () => box().click()); await flush();
  expect(harnessApi.codexHooks).toHaveBeenLastCalledWith(true);
  expect(box().checked).toBe(false);
  // Allowed: on, and the trust step in Codex is still to do
  vi.mocked(harnessApi.codexHooks).mockResolvedValue(true);
  await act(async () => box().click()); await flush();
  expect(box().checked).toBe(true);
  expect(host.textContent).toContain('choose "Trust all and continue"');
  // Off again needs no question
  vi.mocked(harnessApi.codexHooks).mockResolvedValue(false);
  await act(async () => box().click()); await flush();
  expect(harnessApi.codexHooks).toHaveBeenLastCalledWith(false);
  expect(box().checked).toBe(false);
});

it('answers program status queries only after the native question, and is off by default (MCR-115)', async () => {
  await act(async () => root.render(<HarnessSettingsSection/>)); await flush();
  const box = () => host.querySelector('input[aria-label="Answer program status queries"]') as HTMLInputElement;
  expect(box().checked).toBe(false);
  expect(host.textContent).toContain('Off: nothing is answered; reports are shown all the same.');
  // Cancelled in the native dialog: still off
  vi.mocked(harnessApi.programQuery).mockResolvedValue(false);
  await act(async () => box().click()); await flush();
  expect(harnessApi.programQuery).toHaveBeenLastCalledWith(true);
  expect(box().checked).toBe(false);
  vi.mocked(harnessApi.programQuery).mockResolvedValue(true);
  await act(async () => box().click()); await flush();
  expect(box().checked).toBe(true);
  expect(host.textContent).toContain('never into a line you have not sent');
  vi.mocked(harnessApi.programQuery).mockResolvedValue(false);
  await act(async () => box().click()); await flush();
  expect(harnessApi.programQuery).toHaveBeenLastCalledWith(false);
  expect(box().checked).toBe(false);
});

it('says that Codex hooks report once a session has used them', async () => {
  vi.mocked(harnessApi.status).mockResolvedValue({ runner: { protocol: 1, pid: 7, version: '0.1.0', exe: '/x' }, profiles: prefs.profiles, home: '/Users/me', codexHooks: true, codexHooksReporting: true });
  await act(async () => root.render(<HarnessSettingsSection/>)); await flush();
  expect((host.querySelector('input[aria-label="Use Codex hooks"]') as HTMLInputElement).checked).toBe(true);
  expect(host.textContent).toContain('On, and Codex runs them: a session has reported through them.');
  expect(host.textContent).not.toContain('Trust all and continue');
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

it('shows background processes and stops all of them from Settings', async () => {
  vi.mocked(harnessApi.background).mockResolvedValue({
    consent: 'allowed',
    sessions: 1,
    units: [
      { name: 'runner', label: 'x.runner', plist: '/Users/me/Library/LaunchAgents/x.runner.plist', installed: true, running: true, pid: 7, since: 'Sun Nov 15 14:51:17 2026', version: '0.1.1', exe: '/x' },
      { name: 'harness service', label: 'x.harness', plist: '/Users/me/Library/LaunchAgents/x.harness.plist', installed: true, running: false, pid: null, since: null, version: null, exe: null },
    ],
  });
  vi.mocked(harnessApi.stopBackground).mockResolvedValue(true);
  await act(async () => root.render(<HarnessSettingsSection/>)); await flush();
  const manage = [...host.querySelectorAll('button')].find(b => b.textContent === 'Manage…') as HTMLButtonElement;
  await act(async () => manage.click()); await flush();
  const panel = host.querySelector('.hs-background') as HTMLElement;
  expect([...panel.querySelectorAll('dd')].map(d => d.textContent)).toEqual([
    'pid 7 · 0.1.1 · since Sun Nov 15 14:51:17 2026', '~/Library/LaunchAgents/x.runner.plist', 'not running', '~/Library/LaunchAgents/x.harness.plist',
  ]);
  const stop = [...panel.querySelectorAll('button')].find(b => b.textContent === 'Stop everything…') as HTMLButtonElement;
  await act(async () => stop.click()); await flush();
  expect(harnessApi.stopBackground).toHaveBeenCalledWith(false);
  expect(host.querySelector('.hs-background')).toBeNull();
});
