// @vitest-environment happy-dom
import { act, Profiler, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionWorkspace from './SessionWorkspace';
import { askBanner, useBannerIntent } from '../utils/bannerIntent';
import { sessionApi, type Session } from '../utils/sessions';
import { harnessApi, type Hosted } from '../utils/harness';
import { createPlugin, pluginRegistry } from '../plugins';
import { controlsIn, dragsWindow } from '../utils/dragRegion.testing';
import type { TitleBar } from '../utils/windowChrome';
const chrome = vi.hoisted(() => ({ bar: 'native' as TitleBar }));
vi.mock('../utils/windowChrome', async importOriginal => ({ ...await importOriginal<object>(), useTitleBar: () => chrome.bar }));
vi.mock('../utils/sessions', async importOriginal => ({ ...await importOriginal<object>(), sessionApi: { access: vi.fn(), enable: vi.fn(), disable: vi.fn(), snapshot: vi.fn(), journalSince: vi.fn(), detail: vi.fn(), control: vi.fn(), context: vi.fn() } }));
vi.mock('../utils/tauri', () => ({ isTauri: () => true }));
vi.mock('../utils/agent', () => ({ formatAge: () => 'just now' }));
// The Live view connects to the runner; these tests are about History.
vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(() => new Promise(() => {})), listSince: vi.fn(), spawn: vi.fn() } }));
const session: Session = { id:'a',provider:'codex',parentId:null,name:'root',cwd:'/work/demo',title:'Fix CORE-123',model:'model-a',effort:'high',started:'2026-01-01T00:00:00Z',updated:'2026-01-01T00:00:00Z',modified:Date.now(),status:'working',usage:{input:100,cached:70,cacheWrite:0,output:20,reasoning:5},usageKnown:true,models:{},tools:{shell:2},tickets:['CORE-123'],memoryRefs:[],events:[{seq:1,at:'2026-01-01T00:00:00Z',kind:'assistant',text:'<script>untrusted()</script>',tool:null}],eventCount:1,malformedLines:0,source:'/fake/session.jsonl',turnId:'turn'};
let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve,0)); }); };
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim().toLowerCase() === text) || [...host.querySelectorAll('button')].find(b => b.textContent?.toLowerCase().includes(text))!;
beforeEach(() => { vi.resetAllMocks(); useBannerIntent.setState({ intent: null }); localStorage.setItem('agent-mcr.sessions.view','history'); Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);vi.mocked(sessionApi.access).mockResolvedValue(true);vi.mocked(sessionApi.snapshot).mockResolvedValue({sessions:[{...session,events:[]}],scannedFiles:1,pendingFiles:0,indexedAt:Date.now(),errors:[]});vi.mocked(sessionApi.detail).mockResolvedValue(session);
  // The stamped read answers with what `snapshot` gives, each time as changed
  let stamps = 0; vi.mocked(sessionApi.journalSince).mockImplementation(async () => ({ stamp: `s${++stamps}`, snapshot: await sessionApi.snapshot() }));
  vi.mocked(harnessApi.listSince).mockImplementation(async stamp => ({ stamp: 'live', sessions: stamp ? null : [] }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe('Sessions workspace', () => {
  it('reads the snapshot every minute while Live is shown, and every five seconds in Journal (MCR-139)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      localStorage.setItem('agent-mcr.sessions.view', 'live');
      await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush();
      const reads = () => vi.mocked(sessionApi.journalSince).mock.calls.length;
      const first = reads();
      await act(async () => { vi.advanceTimersByTime(55_000); }); await flush();
      expect(reads()).toBe(first);
      await act(async () => { vi.advanceTimersByTime(5_000); }); await flush();
      expect(reads()).toBe(first + 1);
      // Journal: read at once, then every five seconds
      await act(async () => button('journal').click()); await flush();
      const journal = reads();
      expect(journal).toBe(first + 2);
      await act(async () => { vi.advanceTimersByTime(5_000); }); await flush();
      expect(reads()).toBe(journal + 1);
    } finally { vi.useRealTimers(); }
  });

  it('takes the index again only when its content changed, and says which stamp it holds (MCR-141)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const full = await sessionApi.snapshot();
      let finish!: (answer: { stamp: string; snapshot: null }) => void;
      vi.mocked(sessionApi.journalSince).mockReset()
        .mockResolvedValueOnce({ stamp: 'a', snapshot: full })
        .mockReturnValue(new Promise(resolve => { finish = resolve; }));
      const commit = vi.fn();
      await act(async () => root.render(<Profiler id="journal" onRender={commit}><SessionWorkspace onClose={() => {}}/></Profiler>)); await flush();
      expect(host.textContent).toContain('Fix CORE-123');
      commit.mockClear();
      await act(async () => { vi.advanceTimersByTime(5000); }); await flush();
      expect(commit).not.toHaveBeenCalled();
      await act(async () => finish({ stamp: 'a', snapshot: null }));
      // The second read names the stamp held; an answer without a snapshot keeps what is shown
      expect(vi.mocked(sessionApi.journalSince).mock.calls.map(c => c[0])).toEqual(['', 'a']);
      expect(vi.mocked(harnessApi.listSince).mock.calls.map(c => c[0])).toEqual(['', 'live']);
      expect(host.textContent).toContain('Fix CORE-123');
    } finally { vi.useRealTimers(); }
  });
  it('keeps unchanged rows when a Journal poll moves a changed session and removes another', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const full = await sessionApi.snapshot();
      const second = { ...session, id: 'b', source: '/fake/b.jsonl', title: 'Another task', events: [] };
      const third = { ...session, id: 'c', source: '/fake/c.jsonl', title: 'Removed task', events: [] };
      vi.mocked(sessionApi.journalSince)
        .mockResolvedValueOnce({ stamp: 'a', snapshot: { ...full, sessions: [...full.sessions, second, third] } })
        .mockResolvedValueOnce({ stamp: 'b', snapshot: { ...full, sessions: [{ ...second, title: 'Changed task' }] }, positions: [0], removed: [third.source] });
      await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush();
      expect(host.textContent).toContain(third.title);
      const detailReads = vi.mocked(sessionApi.detail).mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(5000); }); await flush();
      expect(host.textContent).toContain('Fix CORE-123');
      expect(host.textContent).toContain('Changed task');
      expect(host.textContent).not.toContain(second.title);
      expect(host.textContent).not.toContain(third.title);
      expect(sessionApi.detail).toHaveBeenCalledTimes(detailReads);
    } finally { vi.useRealTimers(); }
  });
  it('opens on the Live view until Journal is chosen, and remembers the choice', async () => {
    localStorage.removeItem('agent-mcr.sessions.view');
    await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush();
    expect(host.textContent).toContain('Open supervisor');
    expect(host.textContent).not.toContain('Fix CORE-123');
    await act(async () => button('journal').click()); await flush();
    expect(host.textContent).toContain('Fix CORE-123');
    expect(localStorage.getItem('agent-mcr.sessions.view')).toBe('history');
  });
  it('renders actual session details as text and loads linked work only on request', async () => {
    await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush();
    expect(host.textContent).toContain('Fix CORE-123');expect(host.textContent).toContain('<script>untrusted()</script>');expect(host.querySelector('script')).toBeNull();
    await act(async () => button('linked work').click());expect(host.textContent).toContain('CORE-123');
    expect(host.querySelector('.sc-ticket-list button')).toBeNull();
  });
  it('draws a found session as the Live list does: an earlier one as mark, title and age', async () => {
    await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush();
    const row = host.querySelector('.ss-results .sc-session')!;
    expect(row.classList.contains('hs-item') && row.classList.contains('hs-resume')).toBe(true);
    expect(row.querySelector('strong')?.textContent?.trim()).toBe('Fix CORE-123');
    expect([...row.querySelectorAll('small')].map(e => e.textContent)).toEqual(['just now']);
    expect(row.querySelector('.hs-dot')).toBeNull();
    // Tokens, origin and the guessed state are in the tooltip, as the list keeps its detail
    expect(row.textContent).not.toMatch(/tokens|working|unknown/);
    expect(row.getAttribute('title')).toContain('120 tokens');
    expect(row.getAttribute('title')).toContain('working (inferred from the transcript)');
    expect(host.querySelector('.ss-dir .hs-dir-path')?.textContent).toContain('demo');
  });
  it('draws a found session that runs now as its Live row', async () => {
    const hosted: Hosted = { id: 'h1', pid: 42, argv: ['codex'], cwd: '/work/demo', started: 1, cols: 120, rows: 32, title: '', lastOutput: 1, exit: null, unread: 1,
      meta: { label: 'Codex', profile: 'codex', name: 'Parser fixer' }, harness: { profile: 'codex', state: 'waiting', agentSession: 'a', attention: { kind: 'permission', text: 'Approve the command?' } } as Hosted['harness'] };
    vi.mocked(harnessApi.listSince).mockResolvedValue({ stamp: 'live', sessions: [hosted] });
    await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush(); await flush();
    const row = host.querySelector('.ss-results .sc-session')!;
    expect(row.classList.contains('hs-resume')).toBe(false);
    expect(row.querySelector('.hs-dot.waiting')).not.toBeNull();
    expect(row.querySelector('strong')?.textContent?.trim()).toBe('Parser fixer');
    expect([...row.querySelectorAll('small')].map(e => e.textContent)).toEqual(['1 unread', 'Approve the command?']);
    // The name's own tooltip must not hide the detail the row left out
    expect(row.querySelector('strong')?.getAttribute('title')).toContain('120 tokens');
    // Selecting it still opens the conversation in the Journal
    await act(async () => (row as HTMLElement).click());
    expect(row.classList.contains('selected')).toBe(true);
  });
  it('shows an ended hosted conversation in Journal and selects the new session when resumed', async () => {
    const ended: Hosted = { id: 'old', pid: 42, argv: ['codex'], cwd: session.cwd, started: 1, cols: 120, rows: 32, title: '',
      exit: { code: 0, signal: null, at: 2 }, meta: { profile: 'codex' }, harness: { profile: 'codex', agentSession: session.id } as Hosted['harness'] };
    vi.mocked(harnessApi.listSince).mockResolvedValue({ stamp: 'ended', sessions: [ended] });
    vi.mocked(harnessApi.spawn).mockResolvedValue({ ...ended, id: 'resumed', exit: null });
    const selected = vi.spyOn(pluginRegistry, 'emitEvent');
    try {
      await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush();
      expect(host.querySelector('.ss-results .hs-resume')?.textContent).toContain(session.title);
      await act(async () => button('resume in live').click()); await flush();
      expect(harnessApi.spawn).toHaveBeenCalledWith('', '', 120, 32, session.id);
      expect(button('live').getAttribute('aria-current')).toBe('page');
      expect(selected).toHaveBeenCalledWith('session:selected', { id: 'resumed' });
    } finally { selected.mockRestore(); }
  });
  it('switches to Live for a clicked banner, from Journal too, once per click (MCR-180)', async () => {
    await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush();
    expect(button('journal').getAttribute('aria-current')).toBe('page');
    await act(async () => askBanner('clicked')); await flush();
    expect(button('live').getAttribute('aria-current')).toBe('page');
    // The same ask rendered again does not take the operator back to Live; a second click does
    await act(async () => button('journal').click()); await flush();
    await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush();
    expect(button('journal').getAttribute('aria-current')).toBe('page');
    await act(async () => askBanner('clicked')); await flush();
    expect(button('live').getAttribute('aria-current')).toBe('page');
  });
  it('mounts the global overlays only while Sessions is shown, so their keys stay free over Documents', async () => {
    const onKey = vi.fn();
    function Overlay() { useEffect(() => { window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []); return <div data-overlay="test"/>; }
    pluginRegistry.register(createPlugin({ id: 'test-overlay', name: 'Test overlay', setup(api) { api.registerGlobalOverlay({ id: 'test-overlay', render: () => <Overlay key="test-overlay"/> }); } }));
    const cmdS = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }));
    try {
      await act(async () => root.render(<SessionWorkspace active={false} onClose={() => {}}/>)); await flush();
      expect(host.querySelector('[data-overlay]')).toBeNull();
      await act(async () => { cmdS(); });
      expect(onKey).not.toHaveBeenCalled();
      // The built-in command panel is one of them: Cmd+S over Documents is Save, not the palette
      expect(document.querySelector('.cmd-panel, [role="dialog"]')).toBeNull();
      await act(async () => root.render(<SessionWorkspace active onClose={() => {}}/>)); await flush();
      expect(host.querySelector('[data-overlay]')).not.toBeNull();
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
      expect(onKey).toHaveBeenCalledTimes(1);
      await act(async () => root.render(<SessionWorkspace active={false} onClose={() => {}}/>)); await flush();
      expect(host.querySelector('[data-overlay]')).toBeNull();
    } finally { pluginRegistry.unregister('test-overlay'); }
  });
  it('does not read transcripts before access is enabled', async () => {
    vi.mocked(sessionApi.access).mockResolvedValue(false);
    await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>));await flush();expect(host.textContent).toContain('Enable session access');expect(sessionApi.snapshot).not.toHaveBeenCalled();
  });
  it('is the window top row on macOS: the empty space drags, every tab and button clicks, no inset in full screen', async () => {
    try {
      chrome.bar = 'overlay';
      await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush();
      const row = host.querySelector('.sc-topbar') as HTMLElement;
      expect(row.getAttribute('data-tauri-drag-region')).toBe('deep');
      expect(row.style.paddingLeft).toBe('88px');
      expect(dragsWindow(row)).toBe(true);
      expect(dragsWindow(row.querySelector('.hs-view-switch')!)).toBe(true);
      const tabs = ['documents', 'sessions', 'live', 'journal', 'board', 'slack', 'settings'];
      for (const tab of tabs) expect(dragsWindow(button(tab)), tab).toBe(false);
      const controls = controlsIn(row);
      expect(controls.length).toBeGreaterThanOrEqual(tabs.length);
      for (const c of controls) for (const el of [c, ...c.querySelectorAll('*')]) expect(dragsWindow(el), el.outerHTML.slice(0, 80)).toBe(false);
      chrome.bar = 'fullscreen';
      await act(async () => root.render(<SessionWorkspace onClose={() => {}} active={false}/>)); await flush();
      expect(row.getAttribute('data-tauri-drag-region')).toBeNull();
      expect(row.style.paddingLeft).toBe('');
      expect(dragsWindow(row)).toBe(false);
      chrome.bar = 'native';
      await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>)); await flush();
      expect(row.hasAttribute('data-titlebar')).toBe(false);
      expect(row.hasAttribute('data-tauri-drag-region')).toBe(false);
    } finally { chrome.bar = 'native'; }
  });
});
