// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderPalette } from '@lambda-house/workbench';
import { PaletteTrigger, sessionPaletteProvider } from './SessionPalette';
import { harnessApi, type Hosted } from '../utils/harness';
import type { Session } from '../utils/sessions';
import { journal } from '../journal';
import { useSessionsView } from '../sessionsView';
import { useStore } from '../store';

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
const name = (row: Element) => row.querySelector('strong')?.textContent?.trim();
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
// The journal's store is the app's one; each test starts from its first state
const fresh = journal.store.getState();
/** The palette of the sessions provider over these sessions, as the Workbench draws it. */
const open = async (sessions: Session[]) => {
  journal.store.setState({ enabled: true, snapshot: { ...fresh.snapshot, sessions } });
  await act(async () => root.render(<ProviderPalette providers={[sessionPaletteProvider]} onClose={() => {}}/>));
  await flush();
};

beforeEach(() => {
  vi.resetAllMocks();
  platform.current = 'macos';
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.list).mockResolvedValue([hosted]);
  journal.store.setState(fresh, true);
  useSessionsView.setState({ view: 'history', focus: undefined });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Command panel', () => {
  it('names a running conversation as Live does, puts it first and opens it in Live', async () => {
    await open([session('a', 'Older work', 2), session('b', 'Fix the parser', 1)]);
    const rows = [...document.querySelectorAll('[role="option"]')].filter(r => r.id.includes('session:'));
    expect(rows.map(name)).toEqual(['Reviewer', 'Older work']);
    expect(rows[0].querySelector('.hs-dot.working')?.getAttribute('aria-label')).toBe('working');
    // The preview keeps the transcript's own title and spells out the context
    expect(document.querySelector('.cmd-preview')?.textContent).toContain('Fix the parser');
    expect(document.querySelector('.cmd-preview')?.textContent).toContain('2 compactions');
    await act(async () => (rows[0] as HTMLElement).click());
    expect(useSessionsView.getState().view).toBe('live');
    expect(useSessionsView.getState().focus?.id).toBe('h1');
  });

  it('shows an earlier one in the Journal', async () => {
    useSessionsView.setState({ view: 'board' });
    await open([session('a', 'Older work', 2)]);
    const show = vi.spyOn(journal.store.getState(), 'show');
    await act(async () => document.querySelector<HTMLElement>('[role="option"][id*="session:"]')!.click());
    expect(show).toHaveBeenCalledWith('claude:a');
    expect(useSessionsView.getState().view).toBe('history');
  });

  it('keeps its quick filter from one opening to the next', async () => {
    await open([session('a', 'Older work', 2), session('b', 'Fix the parser', 1)]);
    const pill = (text: string) => [...document.querySelectorAll<HTMLElement>('.cmd-pill')].find(p => p.textContent?.startsWith(text))!;
    expect(pill('All').textContent).toBe('All2');
    expect(pill('In Live').textContent).toBe('In Live1');
    await act(async () => pill('In Live').click());
    const sessions = () => [...document.querySelectorAll('[role="option"]')].filter(r => r.id.includes('session:')).map(name);
    expect(sessions()).toEqual(['Reviewer']);
    await act(async () => root.render(<></>));
    await open([session('a', 'Older work', 2), session('b', 'Fix the parser', 1)]);
    expect(pill('In Live').classList.contains('cmd-pill--active')).toBe(true);
    expect(sessions()).toEqual(['Reviewer']);
    await act(async () => pill('All').click());
  });

  it('draws a found session as the Live list does: its row under the folder, nothing more', async () => {
    const waiting: Hosted = { ...hosted, openTasks: 2, harness: { profile: 'claude', state: 'waiting', agentSession: 'b', attention: { kind: 'permission', text: 'Run the tests?' } } as Hosted['harness'] };
    vi.mocked(harnessApi.list).mockResolvedValue([waiting]);
    const elsewhere = { ...session('c', 'Other folder', 3), cwd: '/Users/me/other' };
    await open([elsewhere, session('a', 'Older work', 2), session('b', 'Fix the parser', 1)]);
    const list = document.querySelector('[role="listbox"]')!;
    // The running one first, and its folder's other session with it; then the other folder
    const order = [...list.querySelectorAll('.cmd-dir, [role="option"][id*="session:"]')].map(e => e.matches('.cmd-dir') ? `[${e.textContent}]` : name(e));
    expect(order).toEqual(['[~/repo]', 'Reviewer', 'Older work', '[~/other]', 'Other folder']);
    const [live, earlier] = [...list.querySelectorAll('[role="option"]')];
    // The live row: dot, name, figures, and a line only for what is there
    expect(live.querySelector('.hs-dot.waiting')).not.toBeNull();
    expect(live.querySelector('.hs-metrics')).not.toBeNull();
    expect([...live.querySelectorAll('small')].map(e => e.textContent)).toEqual(['2 tasks', 'Run the tests?']);
    // The folder is in the option's name: the heading is not read with it
    expect([live, earlier].map(r => r.getAttribute('aria-label'))).toEqual(['Reviewer, waiting for you, in ~/repo', 'Older work, in ~/repo']);
    // The earlier row: mark, title and age
    expect(earlier.classList.contains('hs-resume')).toBe(true);
    expect(earlier.querySelector('.hs-dot, .hs-metrics')).toBeNull();
    expect(earlier.querySelectorAll('small').length).toBe(1);
    // Neither names the folder, the model or the state in words: those are the heading, the preview and the dot
    for (const row of [live, earlier]) {
      expect(row.textContent).not.toContain('repo');
      expect(row.textContent).not.toContain('opus');
      expect(row.querySelector('.cmd-status, .cmd-item__sub')).toBeNull();
    }
    expect(document.querySelector('.cmd-preview')?.textContent).toContain('opus');
  });

  it('uses the same display name as the Live sidebar for supervisor sessions and omits ticket pills', async () => {
    const sup: Hosted = { ...hosted, id: 'sup1', meta: { label: 'Claude Code', profile: 'claude', name: 'ignored', role: 'supervisor' }, harness: { profile: 'claude', state: 'idle', agentSession: 'b' } as Hosted['harness'] };
    vi.mocked(harnessApi.list).mockResolvedValue([sup]);
    const s = { ...session('b', 'Fix the parser', 1), tickets: ['MCR-24', 'MEM-12'] };
    await open([s]);
    const rows = [...document.querySelectorAll('[role="option"]')].filter(r => r.id.includes('session:'));
    expect(rows.map(name)).toEqual(['Supervisor']);
    expect(document.querySelector('.cmd-preview__tickets')).toBeNull();
    expect(document.body.textContent).not.toContain('MCR-24');
    expect(document.body.textContent).not.toContain('MEM-12');
  });

  it('offers to turn access on until it is, and lists no sessions before', async () => {
    journal.store.setState({ enabled: false, snapshot: { ...fresh.snapshot, sessions: [session('a', 'Older work', 2)] } });
    await act(async () => root.render(<ProviderPalette providers={[sessionPaletteProvider]} onClose={() => {}}/>));
    await flush();
    const labels = [...document.querySelectorAll('.cmd-item__label')].map(l => l.textContent);
    expect(labels).toEqual(['Live workspace', 'Settings', 'Enable session access']);
    expect(document.querySelector('.cmd-pill__count')).toBeNull();
  });

  it('shows its key the way the platform writes it, and opens the palette', async () => {
    await act(async () => root.render(<PaletteTrigger/>));
    const trigger = () => host.querySelector('.cmd-trigger-btn')!;
    expect(trigger().querySelector('kbd')?.textContent).toBe('⇧⌘P');
    expect(trigger().getAttribute('aria-keyshortcuts')).toBe('Meta+Shift+P');
    platform.current = 'windows';
    await act(async () => root.render(<PaletteTrigger key="windows"/>));
    expect(trigger().querySelector('kbd')?.textContent).toBe('Ctrl+Shift+P');
    expect(trigger().getAttribute('title')).toContain('Ctrl+Shift+P');
    useStore.setState({ paletteOpen: false });
    await act(async () => (trigger() as HTMLElement).click());
    expect(useStore.getState().paletteOpen).toBe(true);
  });
});
