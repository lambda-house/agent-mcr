// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionCommandPanel from './SessionCommandPanel';
import { harnessApi, type Hosted } from '../utils/harness';
import type { Session } from '../utils/sessions';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { list: vi.fn() } }));
// happy-dom reports the platform of the machine the tests run on; each test names the one it means
const platform = vi.hoisted(() => ({ current: 'macos' as 'macos' | 'windows' | 'linux' }));
vi.mock('../utils/platform', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/platform')>();
  return { ...actual, get PLATFORM() { return platform.current; } };
});

const session = (id: string, title: string, modified: number): Session => ({
  id, provider: 'claude', parentId: null, name: id, cwd: '/Users/me/repo', title, model: 'opus', effort: '', started: '', updated: '', modified,
  status: 'idle', usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, usageKnown: false, models: {}, tools: {}, tickets: [], memoryRefs: [], events: [],
  eventCount: 3, malformedLines: 0, source: '', turnId: '',
  context: { now: 50_000, first: 10_000, peak: 60_000, window: 0, compactions: 2, toolBytes: {}, skills: {} },
});
const hosted: Hosted = { id: 'h1', pid: 42, argv: ['claude'], cwd: '/Users/me/repo', started: 1, cols: 120, rows: 32, title: '', lastOutput: 1, exit: null,
  meta: { label: 'Claude Code', profile: 'claude', name: 'Reviewer' }, harness: { profile: 'claude', state: 'working', agentSession: 'b' } as Hosted['harness'] };

let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };

beforeEach(() => {
  vi.resetAllMocks();
  platform.current = 'macos';
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.list).mockResolvedValue([hosted]);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Command panel', () => {
  it('names a running conversation as Live does, puts it first and opens it in Live', async () => {
    const onOpenLive = vi.fn(), onSelectSession = vi.fn();
    await act(async () => root.render(<SessionCommandPanel open hideTrigger onOpenChange={() => {}} enabled sessions={[session('a', 'Older work', 2), session('b', 'Fix the parser', 1)]}
      directory="" onClearDirectory={() => {}} onSelectSession={onSelectSession} onOpenLive={onOpenLive} onNavigateView={() => {}} onOpenSettings={() => {}} onRefresh={() => {}} onEnableAccess={() => {}} topTabs={[]}/>));
    await flush();
    const rows = [...document.querySelectorAll('[role="option"]')].filter(r => r.id.includes('session:'));
    expect(rows.map(r => r.querySelector('.cmd-item__label')?.textContent)).toEqual(['Reviewer', 'Older work']);
    expect(rows[0].querySelector('.cmd-status--live')?.textContent).toBe('working');
    // The preview keeps the transcript's own title and spells out the context
    expect(document.querySelector('.cmd-preview')?.textContent).toContain('Fix the parser');
    expect(document.querySelector('.cmd-preview')?.textContent).toContain('2 compactions');
    await act(async () => (rows[0] as HTMLElement).click());
    expect(onOpenLive).toHaveBeenCalledWith('h1');
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('uses the same display name as the Live sidebar for supervisor sessions and omits ticket pills', async () => {
    const sup: Hosted = { ...hosted, id: 'sup1', meta: { label: 'Claude Code', profile: 'claude', name: 'ignored', role: 'supervisor' }, harness: { profile: 'claude', state: 'idle', agentSession: 'b' } as Hosted['harness'] };
    vi.mocked(harnessApi.list).mockResolvedValue([sup]);
    const s = { ...session('b', 'Fix the parser', 1), tickets: ['MCR-24', 'MEM-12'] };
    await act(async () => root.render(<SessionCommandPanel open hideTrigger onOpenChange={() => {}} enabled sessions={[s]}
      directory="" onClearDirectory={() => {}} onSelectSession={() => {}} onOpenLive={() => {}} onNavigateView={() => {}} onOpenSettings={() => {}} onRefresh={() => {}} onEnableAccess={() => {}} topTabs={[]}/>));
    await flush();
    const rows = [...document.querySelectorAll('[role="option"]')].filter(r => r.id.includes('session:'));
    expect(rows.map(r => r.querySelector('.cmd-item__label')?.textContent)).toEqual(['Supervisor']);
    expect(document.querySelector('.cmd-preview__tickets')).toBeNull();
    expect(document.body.textContent).not.toContain('MCR-24');
    expect(document.body.textContent).not.toContain('MEM-12');
  });

  it('opens on Cmd+S even while the terminal has focus, and leaves Ctrl+K and Ctrl+S alone', async () => {
    const onOpenChange = vi.fn();
    await act(async () => root.render(<SessionCommandPanel open={false} hideTrigger onOpenChange={onOpenChange} enabled sessions={[]}
      directory="" onClearDirectory={() => {}} onSelectSession={() => {}} onOpenLive={() => {}} onNavigateView={() => {}} onOpenSettings={() => {}} onRefresh={() => {}} onEnableAccess={() => {}} topTabs={[]}/>));
    const term = document.createElement('div');
    term.className = 'hs-terminal';
    const textarea = document.createElement('textarea');
    term.appendChild(textarea);
    host.appendChild(term);
    textarea.focus();

    const ctrlK = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    const ctrlS = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      textarea.dispatchEvent(ctrlK);
      textarea.dispatchEvent(ctrlS);
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(ctrlK.defaultPrevented).toBe(false);
    expect(ctrlS.defaultPrevented).toBe(false);

    const cmdS = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      textarea.dispatchEvent(cmdS);
    });
    expect(cmdS.defaultPrevented).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('leaves Cmd+Shift+S (Save All) alone', async () => {
    const onOpenChange = vi.fn();
    await act(async () => root.render(<SessionCommandPanel open={false} hideTrigger onOpenChange={onOpenChange} enabled sessions={[]}
      directory="" onClearDirectory={() => {}} onSelectSession={() => {}} onOpenLive={() => {}} onNavigateView={() => {}} onOpenSettings={() => {}} onRefresh={() => {}} onEnableAccess={() => {}} topTabs={[]}/>));
    for (const key of ['s', 'S']) {
      const saveAll = new KeyboardEvent('keydown', { key, metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
      await act(async () => { window.dispatchEvent(saveAll); });
      expect(saveAll.defaultPrevented).toBe(false);
    }
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('opens on Ctrl+Shift+P off macOS, even in a terminal, and leaves Ctrl+S (Save, shell history search) alone', async () => {
    platform.current = 'windows';
    const onOpenChange = vi.fn();
    await act(async () => root.render(<SessionCommandPanel open={false} onOpenChange={onOpenChange} enabled sessions={[]}
      directory="" onClearDirectory={() => {}} onSelectSession={() => {}} onOpenLive={() => {}} onNavigateView={() => {}} onOpenSettings={() => {}} onRefresh={() => {}} onEnableAccess={() => {}} topTabs={[]}/>));
    const trigger = host.querySelector('.cmd-trigger-btn')!;
    expect(trigger.querySelector('kbd')?.textContent).toBe('Ctrl+Shift+P');
    expect(trigger.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+P');
    expect(trigger.getAttribute('title')).toContain('Ctrl+Shift+P');
    expect(host.textContent).not.toContain('⌘');

    const textarea = document.createElement('textarea');
    host.appendChild(textarea);
    textarea.focus();
    for (const init of [{ key: 's', ctrlKey: true }, { key: 'S', ctrlKey: true, shiftKey: true }, { key: 's', metaKey: true }, { key: 'p', ctrlKey: true }]) {
      const press = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      await act(async () => { textarea.dispatchEvent(press); });
      expect(press.defaultPrevented).toBe(false);
    }
    expect(onOpenChange).not.toHaveBeenCalled();

    const palette = new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => { textarea.dispatchEvent(palette); });
    expect(palette.defaultPrevented).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('shows Cmd+S on macOS', async () => {
    await act(async () => root.render(<SessionCommandPanel open={false} onOpenChange={() => {}} enabled sessions={[]}
      directory="" onClearDirectory={() => {}} onSelectSession={() => {}} onOpenLive={() => {}} onNavigateView={() => {}} onOpenSettings={() => {}} onRefresh={() => {}} onEnableAccess={() => {}} topTabs={[]}/>));
    const trigger = host.querySelector('.cmd-trigger-btn')!;
    expect(trigger.querySelector('kbd')?.textContent).toBe('⌘S');
    expect(trigger.getAttribute('aria-keyshortcuts')).toBe('Meta+S');
  });
});
