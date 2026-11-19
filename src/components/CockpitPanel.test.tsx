// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CockpitPanel from './CockpitPanel';
import { harnessApi, type Cockpit, type Hosted } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { cockpit: vi.fn() } }));
vi.mock('../utils/agent', () => ({ formatAge: () => 'a while ago' }));

const session = (id: string, name: string, over: Partial<Hosted> = {}): Hosted => ({ id, pid: 1, argv: ['claude'], cwd: '/work', started: 1, cols: 80, rows: 24, title: '', lastOutput: 1, exit: null, meta: { label: 'Claude Code', profile: 'claude' }, harness: { name, named: true, profile: 'claude', state: 'working' } as Hosted['harness'], ...over });
const hosted = [session('b1', 'Builder', { openTasks: 1, harness: { name: 'Builder', named: true, profile: 'claude', state: 'waiting' } as Hosted['harness'] }), session('r1', 'Reviewer')];
const label = (h: Hosted) => h.harness?.name ?? h.id;
const doc: Cockpit = {
  schema: 1, version: 3, updated: Date.now(),
  sessions: { b1: { name: 'Builder' }, r1: { name: 'Reviewer' }, old: { name: 'Old lead', ended: true } },
  tracks: [
    { id: 'store', title: 'Store load', lead: 'b1', by: 'b1', state: 'waiting_human', line: 'review done, merge waits', updated: Date.now(), refs: ['MCR-99'], items: [
      { id: 'i1', title: 'merge', ref: 'MCR-99', owner: 'human', state: 'waiting', waitsOn: { kind: 'human', what: 'your word' } },
      { id: 'i2', title: 'second review', owner: 'r1', state: 'review', waitsOn: { kind: 'ci', what: 'CI run 7', derived: 'wait', overdue: true } },
    ] },
    { id: 'gone', title: 'Old track', lead: 'old', by: 'old', state: 'parked', updated: 1 },
  ],
  actions: [
    { id: 'word', title: 'Say the merge word', kind: 'typed_word', by: 'b1', track: 'store', where: { session: 'b1' }, say: 'merge MCR-99', risk: 'irreversible', urgency: 'today', updated: Date.now(), why: 'Review is done.' },
    { id: 'prompt:r1', title: 'Reviewer asks for your answer in its terminal', kind: 'answer_prompt', derived: 'prompt', where: { session: 'r1' }, since: Date.now() },
  ],
};

let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const opened: string[] = [];
const show = async () => { await act(async () => root.render(<CockpitPanel active hosted={hosted} label={label} onSession={id => opened.push(id)}/>)); await flush(); };

beforeEach(() => {
  vi.resetAllMocks(); opened.length = 0;
  localStorage.removeItem('hs-cockpit-closed'); localStorage.removeItem('hs-cockpit-height');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.cockpit).mockResolvedValue(doc);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('puts what needs the person first, the prompt before the published action, then one line per track', async () => {
  await show();
  expect([...host.querySelectorAll('.ck-action')].map(a => a.getAttribute('data-action'))).toEqual(['prompt:r1', 'word']);
  expect([...host.querySelectorAll('.ck-track')].map(t => t.getAttribute('data-track'))).toEqual(['store', 'gone']);
  expect(host.querySelector('.ck-head')!.textContent).toContain('2 need you');
  const track = host.querySelector('[data-track="store"]')!;
  expect(track.textContent).toContain('waits for you');
  expect(track.textContent).toContain('review done, merge waits');
  expect(track.textContent).toContain('waits on you, CI run 7');
});

it('draws what the harness knows apart from what a session published', async () => {
  await show();
  const word = host.querySelector('[data-action="word"]')!;
  // Live: Builder waits for the person and has a task, although the published action says nothing of it
  expect([...word.querySelectorAll('.ck-live')].map(c => c.textContent)).toEqual(['waiting for you', '1 open task']);
  expect(word.querySelector('.ck-source')!.textContent).toContain('published by Builder');
  expect(word.querySelector('.ck-say code')!.textContent).toBe('merge MCR-99');
  expect(host.querySelector('[data-action="prompt:r1"] .ck-source')!.textContent).toContain('seen by the harness');
});

it('offers no click but opening a session: the line to type is text, and no action has a button of its own', async () => {
  await show();
  const buttons = [...host.querySelectorAll('.ck-action button')];
  expect(buttons.every(b => b.classList.contains('ck-session'))).toBe(true);
  expect(host.querySelector('.ck-action a')).toBeNull();
  await act(async () => (host.querySelector('[data-action="word"] .ck-session') as HTMLButtonElement).click());
  expect(opened).toEqual(['b1']);
});

it('opens a track to its items, with the lead as its row in the list', async () => {
  await show();
  expect(host.querySelector('.ck-track-body')).toBeNull();
  await act(async () => (host.querySelector('[data-track="store"] .ck-expand') as HTMLButtonElement).click());
  const body = host.querySelector('[data-track="store"] .ck-track-body')!;
  expect(body.querySelector('.ck-lead .hs-dot.waiting')).not.toBeNull();
  expect([...body.querySelectorAll('.ck-item')].map(i => i.querySelector('.ck-item-title')!.textContent)).toEqual(['MCR-99 merge', 'second review']);
  expect(body.querySelector('.ck-item .ck-live.late')!.textContent).toContain('waits for CI run 7 (late)');
  await act(async () => (body.querySelector('.ck-lead') as HTMLButtonElement).click());
  expect(opened).toEqual(['b1']);
});

it('marks a track whose publisher ended and names its lead without a link', async () => {
  await show();
  const old = host.querySelector('[data-track="gone"]')!;
  expect(old.querySelector('.ck-stale')!.textContent).toContain('its publisher Old lead ended');
  expect(old.querySelector('button.ck-session')).toBeNull();
  expect(old.querySelector('.ck-session.gone')!.textContent).toBe('Old lead (ended)');
});

it('says so when nothing is published, and when the cockpit cannot be read', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, tracks: [], actions: [] });
  await show();
  expect(host.querySelector('.ck-empty')!.textContent).toContain('Nothing is published yet');
  expect(host.querySelector('.ck-head')!.textContent).toContain('nothing needs you');
  act(() => root.unmount()); root = createRoot(host);
  vi.mocked(harnessApi.cockpit).mockRejectedValue('Unknown op cockpit');
  await show();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('could not be read');
});

it('does not say that nothing needs the person before it has read the cockpit, or when it cannot read it', async () => {
  localStorage.setItem('hs-cockpit-closed', '1');
  vi.mocked(harnessApi.cockpit).mockReturnValue(new Promise(() => {}));
  await show();
  expect(host.querySelector('.ck-head')!.textContent).toContain('reading');
  expect(host.querySelector('.ck-head')!.textContent).not.toContain('nothing needs you');
  act(() => root.unmount()); root = createRoot(host);
  vi.mocked(harnessApi.cockpit).mockRejectedValue('Harness service unavailable');
  await show();
  expect(host.querySelector('.ck-head [role="alert"]')!.textContent).toBe('could not be read');
  expect(host.querySelector('.ck-head')!.textContent).not.toContain('nothing needs you');
});

it('names a session the service says runs, and the list has not shown yet, without calling it ended', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, sessions: { ...doc.sessions, late: { name: 'Late one', state: 'working' } }, tracks: [{ id: 'l', title: 'Late track', lead: 'late', by: 'late', state: 'moving', updated: Date.now() }], actions: [] });
  await show();
  const track = host.querySelector('[data-track="l"]')!;
  expect(track.querySelector('.ck-session')!.textContent).toBe('Late one');
  expect(track.querySelector('.ck-stale')).toBeNull();
});

it('can be collapsed, and stays so', async () => {
  await show();
  await act(async () => (host.querySelector('.ck-head .ck-expand') as HTMLButtonElement).click());
  expect(host.querySelector('.ck-body')).toBeNull();
  expect(host.querySelector('.ck-resizer')).toBeNull();
  expect(host.querySelector('.ck-head')!.textContent).toContain('2 need you');
  act(() => root.unmount()); root = createRoot(host);
  await show();
  expect(host.querySelector('.ck-body')).toBeNull();
});
