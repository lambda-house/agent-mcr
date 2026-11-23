// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionWorkspace from './SessionWorkspace';
import { sessionApi, type Session } from '../utils/sessions';
import { harnessApi, type Hosted } from '../utils/harness';
import { createPlugin, pluginRegistry } from '../plugins';
import { journal } from '../journal';
vi.mock('../utils/sessions', async importOriginal => ({ ...await importOriginal<object>(), sessionApi: { access: vi.fn(), enable: vi.fn(), disable: vi.fn(), snapshot: vi.fn(), detail: vi.fn(), control: vi.fn(), context: vi.fn() } }));
vi.mock('../utils/tauri', () => ({ isTauri: () => true }));
vi.mock('../utils/agent', () => ({ formatAge: () => 'just now' }));
// The Live view connects to the runner; these tests are about History.
vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(() => new Promise(() => {})), list: vi.fn() } }));
const session: Session = { id:'a',provider:'codex',parentId:null,name:'root',cwd:'/work/demo',title:'Fix CORE-123',model:'model-a',effort:'high',started:'2026-01-01T00:00:00Z',updated:'2026-01-01T00:00:00Z',modified:Date.now(),status:'working',usage:{input:100,cached:70,cacheWrite:0,output:20,reasoning:5},usageKnown:true,models:{},tools:{shell:2},tickets:['CORE-123'],memoryRefs:[],events:[{seq:1,at:'2026-01-01T00:00:00Z',kind:'assistant',text:'<script>untrusted()</script>',tool:null}],eventCount:1,malformedLines:0,source:'/fake/session.jsonl',turnId:'turn'};
// The journal's store is the app's one; each test starts from its first state
const fresh = journal.store.getState();
let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve,0)); }); };
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim().toLowerCase() === text) || [...host.querySelectorAll('button')].find(b => b.textContent?.toLowerCase().includes(text))!;
beforeEach(() => { vi.resetAllMocks(); journal.store.setState(fresh, true); localStorage.setItem('agent-mcr.sessions.view','history'); Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);vi.mocked(sessionApi.access).mockResolvedValue(true);vi.mocked(sessionApi.snapshot).mockResolvedValue({sessions:[{...session,events:[]}],scannedFiles:1,pendingFiles:0,indexedAt:Date.now(),errors:[]});vi.mocked(sessionApi.detail).mockResolvedValue(session); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe('Sessions workspace', () => {
  it('opens on the Live view until Journal is chosen, and remembers the choice', async () => {
    localStorage.removeItem('agent-mcr.sessions.view');
    await act(async () => root.render(<SessionWorkspace />)); await flush();
    expect(host.textContent).toContain('Open supervisor');
    // The journal stays mounted under Live (its snapshot names Live's sessions), hidden
    const journalView = () => host.querySelector('[data-view="history"]') as HTMLElement;
    expect(journalView().hidden).toBe(true);
    await act(async () => button('journal').click()); await flush();
    expect(journalView().hidden).toBe(false);
    expect(journalView().textContent).toContain('Fix CORE-123');
    expect(localStorage.getItem('agent-mcr.sessions.view')).toBe('history');
  });
  it('renders actual session details as text and loads linked work only on request', async () => {
    await act(async () => root.render(<SessionWorkspace />)); await flush();
    expect(host.textContent).toContain('Fix CORE-123');expect(host.textContent).toContain('<script>untrusted()</script>');expect(host.querySelector('script')).toBeNull();
    await act(async () => button('linked work').click());expect(host.textContent).toContain('CORE-123');
    expect(host.querySelector('.sc-ticket-list button')).toBeNull();
  });
  it('draws a found session as the Live list does: an earlier one as mark, title and age', async () => {
    await act(async () => root.render(<SessionWorkspace />)); await flush();
    const row = host.querySelector('.ss-results .sc-session')!;
    expect(row.classList.contains('hs-item') && row.classList.contains('hs-resume')).toBe(true);
    expect(row.querySelector('strong')?.textContent?.trim()).toBe('Fix CORE-123');
    expect([...row.querySelectorAll('small')].map(e => e.textContent)).toEqual(['just now']);
    expect(row.querySelector('.hs-dot')).toBeNull();
    // Tokens, origin and the guessed state are in the tooltip, as the list keeps its detail
    expect(row.textContent).not.toMatch(/tokens|working|unknown/);
    expect(row.getAttribute('title')).toContain('120 tokens');
    expect(row.getAttribute('title')).toContain('working (inferred from the transcript)');
    expect(host.querySelector('.ss-dir .ss-dir-path')?.textContent).toContain('demo');
  });
  it('draws a found session that runs now as its Live row', async () => {
    const hosted: Hosted = { id: 'h1', pid: 42, argv: ['codex'], cwd: '/work/demo', started: 1, cols: 120, rows: 32, title: '', lastOutput: 1, exit: null, unread: 1,
      meta: { label: 'Codex', profile: 'codex', name: 'Parser fixer' }, harness: { profile: 'codex', state: 'waiting', agentSession: 'a', attention: { kind: 'permission', text: 'Approve the command?' } } as Hosted['harness'] };
    vi.mocked(harnessApi.list).mockResolvedValue([hosted]);
    await act(async () => root.render(<SessionWorkspace />)); await flush(); await flush();
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
  it('mounts the global overlays only while Sessions is shown, so their keys stay free over Documents', async () => {
    const onKey = vi.fn();
    function Overlay() { useEffect(() => { window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []); return <div data-overlay="test"/>; }
    pluginRegistry.register(createPlugin({ id: 'test-overlay', name: 'Test overlay', setup(api) { api.registerGlobalOverlay({ id: 'test-overlay', render: () => <Overlay key="test-overlay"/> }); } }));
    const cmdS = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }));
    try {
      await act(async () => root.render(<SessionWorkspace active={false} />)); await flush();
      expect(host.querySelector('[data-overlay]')).toBeNull();
      await act(async () => { cmdS(); });
      expect(onKey).not.toHaveBeenCalled();
      // The built-in command panel is one of them: Cmd+S over Documents is Save, not the palette
      expect(document.querySelector('.cmd-panel, [role="dialog"]')).toBeNull();
      await act(async () => root.render(<SessionWorkspace active />)); await flush();
      expect(host.querySelector('[data-overlay]')).not.toBeNull();
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
      expect(onKey).toHaveBeenCalledTimes(1);
      await act(async () => root.render(<SessionWorkspace active={false} />)); await flush();
      expect(host.querySelector('[data-overlay]')).toBeNull();
    } finally { pluginRegistry.unregister('test-overlay'); }
  });
  it('does not read transcripts before access is enabled', async () => {
    vi.mocked(sessionApi.access).mockResolvedValue(false);
    await act(async () => root.render(<SessionWorkspace />));await flush();expect(host.textContent).toContain('Enable session access');expect(sessionApi.snapshot).not.toHaveBeenCalled();
  });
});
