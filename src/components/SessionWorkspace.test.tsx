// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionWorkspace from './SessionWorkspace';
import { sessionApi, type Session } from '../utils/sessions';
vi.mock('../utils/sessions', async importOriginal => ({ ...await importOriginal<object>(), sessionApi: { access: vi.fn(), enable: vi.fn(), disable: vi.fn(), snapshot: vi.fn(), detail: vi.fn(), control: vi.fn(), context: vi.fn() } }));
vi.mock('../utils/tauri', () => ({ isTauri: () => true }));
vi.mock('../utils/agent', () => ({ formatAge: () => 'just now' }));
// The Live view connects to the runner; these tests are about History.
vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { status: vi.fn(() => new Promise(() => {})), list: vi.fn() } }));
const session: Session = { id:'a',provider:'codex',parentId:null,name:'root',cwd:'/work/demo',title:'Fix CORE-123',model:'model-a',effort:'high',started:'2026-01-01T00:00:00Z',updated:'2026-01-01T00:00:00Z',modified:Date.now(),status:'working',usage:{input:100,cached:70,cacheWrite:0,output:20,reasoning:5},usageKnown:true,models:{},tools:{shell:2},tickets:['CORE-123'],memoryRefs:[],events:[{seq:1,at:'2026-01-01T00:00:00Z',kind:'assistant',text:'<script>untrusted()</script>',tool:null}],eventCount:1,malformedLines:0,source:'/fake/session.jsonl',turnId:'turn'};
let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve,0)); }); };
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim().toLowerCase() === text) || [...host.querySelectorAll('button')].find(b => b.textContent?.toLowerCase().includes(text))!;
beforeEach(() => { vi.resetAllMocks(); localStorage.setItem('agent-mcr.sessions.view','history'); Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);vi.mocked(sessionApi.access).mockResolvedValue(true);vi.mocked(sessionApi.snapshot).mockResolvedValue({sessions:[{...session,events:[]}],scannedFiles:1,pendingFiles:0,indexedAt:Date.now(),errors:[]});vi.mocked(sessionApi.detail).mockResolvedValue(session); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe('Sessions workspace', () => {
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
  it('does not read transcripts before access is enabled', async () => {
    vi.mocked(sessionApi.access).mockResolvedValue(false);
    await act(async () => root.render(<SessionWorkspace onClose={() => {}}/>));await flush();expect(host.textContent).toContain('Enable session access');expect(sessionApi.snapshot).not.toHaveBeenCalled();
  });
});
