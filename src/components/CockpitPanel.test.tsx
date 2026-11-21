// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CockpitPanel, { READ_TIMEOUT_MS } from './CockpitPanel';
import { harnessApi, type Cockpit, type Hosted } from '../utils/harness';
import { readFileSync } from 'node:fs';

// Vitest hands CSS imports over empty: the stylesheet is read from disk
const css = readFileSync(`${process.cwd()}/src/styles/harness.css`, 'utf8');

vi.mock('../utils/harness', async importOriginal => ({ ...await importOriginal<object>(), harnessApi: { cockpit: vi.fn(), cockpitAct: vi.fn() } }));
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

it('places the line of a typed word by ids only, says that nothing was sent, and opens that session', async () => {
  vi.mocked(harnessApi.cockpitAct).mockResolvedValue({ placed: 'b1' });
  await show();
  const word = host.querySelector('[data-action="word"]')!;
  // The whole line is on the row, and the publisher's name stands next to the button
  expect(word.querySelector('.ck-say code')!.textContent).toBe('merge MCR-99');
  const place = [...word.querySelectorAll('button.ck-do')].find(b => b.textContent!.startsWith('Place in Builder'))! as HTMLButtonElement;
  expect(place.textContent).toBe('Place in Builder, unsent (irreversible)');
  expect(place.parentElement!.textContent).toContain('from Builder');
  await act(async () => place.click()); await flush();
  // Ids and the stamp on screen: no text, no session
  expect(vi.mocked(harnessApi.cockpitAct).mock.calls).toEqual([['b1', 'word', doc.actions[0].updated, 'place', undefined]]);
  expect(word.querySelector('.ck-said')!.textContent).toContain('not sent. Press Enter there');
  expect(opened).toEqual(['b1']);
  // A row the harness made has no button but the session's name
  expect(host.querySelectorAll('[data-action="prompt:r1"] button.ck-do')).toHaveLength(0);
});

it('shows the service\'s refusal on the row and opens nothing', async () => {
  vi.mocked(harnessApi.cockpitAct).mockRejectedValue('Refused: that session asks you something in its terminal.');
  await show();
  const word = host.querySelector('[data-action="word"]')!;
  await act(async () => ([...word.querySelectorAll('button.ck-do')].find(b => b.textContent!.startsWith('Place'))! as HTMLButtonElement).click()); await flush();
  expect(word.querySelector('.ck-said.bad[role="alert"]')!.textContent).toContain('asks you something');
  expect(opened).toEqual([]);
});

it('offers one button per option of a decision, by its place in the list, with no default among them', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, actions: [{ id: 'pick', title: 'Pick one', kind: 'decision', by: 'supervisor', options: ['MCR-102 launchd labels', 'MCR-97 click actions'], recommended: 'MCR-102 launchd labels', risk: 'reversible', urgency: 'today', updated: 77 }] });
  vi.mocked(harnessApi.cockpitAct).mockResolvedValue({ placed: 'sup1' });
  const withRoot = [...hosted, session('sup1', 'Root', { meta: { label: 'Claude Code', profile: 'claude', role: 'supervisor' } })];
  await act(async () => root.render(<CockpitPanel active hosted={withRoot} label={label} onSession={id => opened.push(id)}/>)); await flush();
  const pick = host.querySelector('[data-action="pick"]')!;
  const options = [...pick.querySelectorAll('.ck-choices button.ck-do')] as HTMLButtonElement[];
  expect(options.map(o => o.textContent)).toEqual(['MCR-102 launchd labels (recommended by its publisher)', 'MCR-97 click actions']);
  // The same look for each: what its publisher recommends, or calls reversible, makes no button the easy one
  expect(new Set(options.map(o => o.className)).size).toBe(1);
  expect(pick.textContent).not.toContain('reversible');
  expect(pick.textContent).toContain('Decision pick: …');
  expect(pick.textContent).toContain('input box of Supervisor, unsent');
  await act(async () => options[1].click()); await flush();
  expect(vi.mocked(harnessApi.cockpitAct).mock.calls).toEqual([['supervisor', 'pick', 77, 'choose', 1]]);
  expect(opened).toEqual(['sup1']);
});

it('has no button for what is behind, for a text the service would refuse, or when the session to answer in does not run', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, actions: [
    { ...doc.actions[0], id: 'typed', ownerTyped: Date.now() },
    { ...doc.actions[0], id: 'old-text', unclickable: ['say'] },
    { ...doc.actions[0], id: 'no-stamp', updated: undefined },
    { id: 'pick', title: 'Pick', kind: 'decision', by: 'gone-publisher', options: ['a', 'b'], updated: 5 },
    { id: 'pr', title: 'Read', kind: 'external', by: 'b1', where: { url: 'http://10.0.0.1/x' }, unclickable: ['url'], updated: 5 },
  ] });
  await show();
  const buttons = (id: string) => [...host.querySelectorAll(`[data-action="${id}"] button.ck-do`)].map(b => b.textContent).filter(t => !t!.startsWith('Ask') && t !== 'Explain');
  expect([buttons('typed'), buttons('old-text'), buttons('no-stamp'), buttons('pick'), buttons('pr')]).toEqual([[], [], [], [], []]);
  expect(host.querySelector('[data-action="old-text"]')!.textContent).toContain('No button');
  expect(host.querySelector('[data-action="pick"] ul.ck-options')).not.toBeNull();
  expect(host.querySelector('[data-action="pr"]')!.textContent).toContain('not a link a click opens');
});

it('asks before a link is opened, with Cancel as the default, and shows where it goes as the service read it', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, actions: [{ id: 'pr', title: 'Read the PR', kind: 'external', by: 'b1', where: { url: 'https://example.com/a?token=abc' }, updated: 9 }] });
  vi.mocked(harnessApi.cockpitAct).mockImplementation(async (_by, _id, _updated, what) => what === 'link' ? { link: { href: 'https://example.com/a?token=abc', host: 'example.com', path: '/a', query: 'token=abc', known: false } } : { opened: 'example.com' });
  await show();
  const pr = host.querySelector('[data-action="pr"]')!;
  await act(async () => ([...pr.querySelectorAll('button.ck-do')].find(b => b.textContent === 'Open link…')! as HTMLButtonElement).click()); await flush();
  const dialog = document.querySelector('.modal')!;
  // Over the whole window: outside the panel, whose columns are containers that would box it in (MCR-105)
  expect(dialog.closest('.modal-overlay')!.parentElement).toBe(document.body);
  expect(host.contains(dialog)).toBe(false);
  expect([...dialog.querySelectorAll('.ck-link dd')].map(d => d.textContent)).toEqual(['example.com', '/a', 'token=abc']);
  expect(dialog.querySelector('.ck-link-warn')!.textContent).toContain('not on your list of known hosts');
  // Cancel has the focus: Enter cancels, and only the link's parts were asked for
  expect((document.activeElement as HTMLElement).textContent).toBe('Cancel');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }); await flush();
  expect(document.querySelector('.modal')).toBeNull();
  expect(vi.mocked(harnessApi.cockpitAct).mock.calls.map(c => c[3])).toEqual(['link']);
  // Asked again and answered with a click on the action: the service is asked to open, by ids
  await act(async () => ([...pr.querySelectorAll('button.ck-do')].find(b => b.textContent === 'Open link…')! as HTMLButtonElement).click()); await flush();
  await act(async () => ([...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Open link')! as HTMLButtonElement).click()); await flush();
  expect(vi.mocked(harnessApi.cockpitAct).mock.calls.map(c => [c[0], c[1], c[2], c[3]])).toEqual([['b1', 'pr', 9, 'link'], ['b1', 'pr', 9, 'link'], ['b1', 'pr', 9, 'open']]);
  expect(pr.querySelector('.ck-said')!.textContent).toBe('Opened example.com in your browser.');
});

it('copies a command by ids, explains from the stored text, and asks the publisher more with a click', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, actions: [{ id: 'look', title: 'Look', kind: 'live_check', by: 'b1', detail: '1. restart\n2. look', where: { command: 'cargo test -- --test-threads=1' }, updated: 4 }] });
  vi.mocked(harnessApi.cockpitAct).mockImplementation(async (_by, _id, _updated, what) => what === 'copy' ? { copied: true } : { placed: 'b1' });
  await show();
  const look = host.querySelector('[data-action="look"]')!;
  const button = (text: string) => [...look.querySelectorAll('button.ck-do')].find(b => b.textContent === text)! as HTMLButtonElement;
  expect(look.querySelector('.ck-say code')!.textContent).toBe('cargo test -- --test-threads=1');
  await act(async () => button('Copy').click()); await flush();
  expect(look.querySelector('.ck-said')!.textContent).toBe('Copied. Nothing was run.');
  expect(look.querySelector('.ck-detail')).toBeNull();
  await act(async () => button('Explain').click());
  expect(look.querySelector('.ck-detail')!.textContent).toBe('1. restart\n2. look');
  await act(async () => button('Ask Builder more').click()); await flush();
  expect(vi.mocked(harnessApi.cockpitAct).mock.calls.map(c => [c[0], c[1], c[2], c[3], c[4]])).toEqual([['b1', 'look', 4, 'copy', undefined], ['b1', 'look', 4, 'ask', undefined]]);
  expect(opened).toEqual(['b1']);
});

it('folds the rows of a publisher that has many, and keeps the harness\'s own rows on top', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, title: `Noise ${i}`, kind: 'live_check' as const, by: 'b1', urgency: 'now' as const, detail: 'x', updated: i + 1 }));
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, actions: [...many, doc.actions[1]] });
  await show();
  expect([...host.querySelectorAll('.ck-action')].map(a => a.getAttribute('data-action'))).toEqual(['prompt:r1', 'n0', 'n1', 'n2']);
  const more = host.querySelector('.ck-more') as HTMLButtonElement;
  expect(more.textContent).toBe('2 more from Builder');
  await act(async () => more.click());
  expect(host.querySelectorAll('.ck-action')).toHaveLength(6);
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

it('shows that the owner typed in a session instead of repeating that it waits for them (MCR-103)', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({
    ...doc,
    tracks: [{ ...doc.tracks[0], ownerTyped: Date.now() - 60000 }],
    actions: [{ ...doc.actions[0], ownerTyped: Date.now() - 60000 }, { id: 'other', title: 'Another thing', kind: 'live_check', by: 'r1', urgency: 'whenever', updated: Date.now() }],
  });
  await show();
  // The action stays in sight, after what still stands, without its urgency and not counted
  expect([...host.querySelectorAll('.ck-action')].map(a => a.getAttribute('data-action'))).toEqual(['other', 'word']);
  const word = host.querySelector('[data-action="word"]')!;
  expect(word.classList.contains('behind')).toBe(true);
  expect(word.querySelector('.ck-urgency')).toBeNull();
  expect(word.querySelector('.ck-live.answered')!.textContent).toContain('you typed there');
  expect(host.querySelector('.ck-head')!.textContent).toContain('1 needs you');
  // The track loses the red state and the "waits on you"
  const track = host.querySelector('[data-track="store"]')!;
  expect(track.querySelector('.ck-state.answered')!.textContent).toContain('you typed');
  expect(track.querySelector('.ck-state.waiting_human')).toBeNull();
  expect(track.textContent).not.toContain('waits on you');
});

it('says nothing new needs the owner when every action is one they already typed for', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, actions: [{ ...doc.actions[0], ownerTyped: Date.now() }] });
  await show();
  expect(host.querySelector('.ck-head .ck-count')!.textContent).toBe('nothing new needs you');
  expect(host.querySelector('.ck-head .ck-count')!.classList.contains('needs')).toBe(false);
});

it('says that the session of an action has ended', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, actions: [{ ...doc.actions[0], where: { session: 'old' }, sessionEnded: true }] });
  await show();
  const word = host.querySelector('[data-action="word"]')!;
  expect(word.querySelector('.ck-live.answered')!.textContent).toBe('its session ended');
  expect(word.querySelector('.ck-urgency')).toBeNull();
});

it('names the publisher apart from the lead when the Supervisor published a track another session leads', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, tracks: [{ ...doc.tracks[0], by: 'supervisor' }, { ...doc.tracks[0], id: 'own' }], actions: [] });
  await show();
  const led = host.querySelector('[data-track="store"]')!;
  expect(led.querySelector('.ck-role')!.textContent).toBe('lead');
  expect(led.querySelector('.ck-age')!.textContent).toContain('by Supervisor');
  // Published by its own lead: one name says both
  const own = host.querySelector('[data-track="own"]')!;
  expect(own.querySelector('.ck-role')).toBeNull();
  expect(own.querySelector('.ck-age')!.textContent).not.toContain('by ');
});

it('keeps the room of a track row for its title: who and when give way, whole in their tooltips (MCR-105)', async () => {
  const long = 'Vadim plugin Windows branches merge status';
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, sessions: { ...doc.sessions, b1: { name: long } }, tracks: [{ ...doc.tracks[0], by: 'supervisor' }], actions: [] });
  await act(async () => root.render(<CockpitPanel active hosted={[session('b1', long), session('r1', 'Reviewer')]} label={label} onSession={() => {}}/>)); await flush();
  const line = host.querySelector('[data-track="store"] .ck-track-line')!;
  // The title stands alone; the lead, the publisher and the age are one group after it, which the
  // stylesheet cuts first and moves under the title in a narrow column
  expect([...line.children].map(c => c.className.split(' ')[0])).toEqual(['ck-expand', 'ck-state', 'ck-track-title', 'ck-track-meta']);
  const meta = line.querySelector('.ck-track-meta')!;
  expect([...meta.children].map(c => c.className.split(' ')[0])).toEqual(['ck-role', 'ck-session', 'ck-age']);
  expect(meta.querySelector('.ck-session')!.getAttribute('title')).toBe(`Open ${long}`);
  expect(meta.querySelector('.ck-age')!.getAttribute('title')).toBe('by Supervisor · a while ago');
  // A cut line of the track says itself whole in its tooltip
  expect(host.querySelector('[data-track="store"] .ck-line')!.getAttribute('title')).toBe('review done, merge waits');
});

it('gives the title of a track a floor and never breaks it at any letter (MCR-105)', () => {
  // The declarations of the first rule whose selector list is exactly this
  const rule = (selector: string) => { const at = css.indexOf(`\n${selector} {`); return at < 0 ? '' : css.slice(at, css.indexOf('}', at)); };
  // "anywhere" made the title's smallest width one letter: the row then ran down the page letter by letter
  expect(css).not.toMatch(/\.ck-track[^{]*\{[^}]*overflow-wrap: anywhere/);
  expect(rule('.ck-track-title')).toContain('min-width: min(10em, 100%)');
  expect(rule('.ck-track-meta')).toContain('min-width: 0');
  expect(css).toMatch(/@container ck-col \(max-width: 460px\) \{[^@]*\.ck-track-meta \{ flex: 1 1 100%/);
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

it('shows a session at a prompt with nothing published, at the first read, and drops it when the prompt is answered (MCR-118)', async () => {
  const empty: Cockpit = { schema: 1, version: 0, updated: 0, sessions: { r1: { name: 'Reviewer' } }, tracks: [], actions: [] };
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...empty, actions: [{ id: 'prompt:r1', title: 'Reviewer asks for your answer in its terminal', kind: 'answer_prompt', derived: 'prompt', where: { session: 'r1' }, since: Date.now() }] });
  await show();
  const row = host.querySelector('[data-action="prompt:r1"]')!;
  expect(row.textContent).toContain('Reviewer asks for your answer in its terminal');
  expect(row.querySelector('.ck-urgency')!.textContent).toBe('now');
  expect(row.classList.contains('derived')).toBe(true);
  expect(host.querySelector('.ck-head')!.textContent).toContain('1 needs you');
  // The row opens its session
  await act(async () => (row.querySelector('.ck-session') as HTMLElement).click());
  expect(opened).toEqual(['r1']);
  // Answered: the next read has no row, and the panel says so
  vi.mocked(harnessApi.cockpit).mockResolvedValue(empty);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
  expect(host.querySelector('[data-action="prompt:r1"]')).toBeNull();
  expect(host.querySelector('.ck-head')!.textContent).toContain('nothing needs you');
});

it('shows how long an unsent line has stood, and an overdue human wait with what the session registered (MCR-118)', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ schema: 1, version: 0, updated: 0, sessions: { b1: { name: 'Builder' }, r1: { name: 'Reviewer' } }, tracks: [], actions: [
    { id: 'held:b1', title: 'Messages and tasks for Builder wait for a line you have not sent there', kind: 'held_line', derived: 'held', where: { session: 'b1' }, since: Date.now() - 12 * 60_000, detail: 'If its input box is empty, press Enter there: nothing is sent and the hold ends. If it holds text, send it, or delete it.' },
    { id: 'wait:w1', title: 'Reviewer waits for you, past the time it expected', kind: 'human_wait', derived: 'wait', where: { session: 'r1' }, since: Date.now() - 3600_000, detail: 'a go for the fault run' },
  ] });
  await show();
  const held = host.querySelector('[data-action="held:b1"]')!;
  expect(held.textContent).toContain('unsent for 12 min');
  expect(held.textContent).toContain('If its input box is empty, press Enter there: nothing is sent and the hold ends.');
  // Never Ctrl+C: in a working agent it stops the turn (MCR-122)
  expect(host.textContent).not.toContain('Ctrl+C');
  expect(held.querySelector('.ck-urgency')!.textContent).toBe('today');
  const wait = host.querySelector('[data-action="wait:w1"]')!;
  expect(wait.textContent).toContain('It registered: a go for the fault run');
  expect(wait.querySelector('.ck-kind')!.textContent).toBe('waits for you');
  // Nothing on a derived row is a button: it only opens its session
  expect([...host.querySelectorAll('.ck-action button')].filter(b => !b.classList.contains('ck-session'))).toEqual([]);
});

it('merges what the harness knows into the published action for the same session: one row, its chips, the harness urgency (MCR-118)', async () => {
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, actions: [
    { ...doc.actions[0], urgency: 'whenever', live: { prompt: Date.now() - 60_000, report: { id: 'r9', since: Date.now(), text: 'Which branch?' } } },
  ] });
  await show();
  const rows = [...host.querySelectorAll('.ck-action')];
  expect(rows.map(r => r.getAttribute('data-action'))).toEqual(['word']);
  const row = rows[0];
  expect(row.classList.contains('merged')).toBe(true);
  expect(row.querySelector('.ck-urgency')!.textContent).toBe('now');
  expect([...row.querySelectorAll('.ck-live.harness')].map(c => c.textContent)).toEqual(['at a prompt · a while ago', 'reported: needs you · a while ago']);
  expect(row.textContent).toContain('Builder reported: Which branch?');
  // No Place while the session asks at a prompt (the service would refuse it): the reason instead
  expect(row.textContent).not.toContain('Place in Builder, unsent');
  expect(row.textContent).toContain('No button while Builder asks at a prompt: answer it there first.');
  expect(row.textContent).not.toContain('the report it names is closed');
  // Once the prompt is answered, the published row has its click again
  vi.mocked(harnessApi.cockpit).mockResolvedValue({ ...doc, actions: [{ ...doc.actions[0], live: { report: { id: 'r9', since: Date.now(), text: 'Which branch?' } } }] });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
  expect(host.querySelector('[data-action="word"]')!.textContent).toContain('Place in Builder, unsent');
});

it('says that the cockpit could not be read when a read hangs, instead of showing the last one as now (MCR-118)', async () => {
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<CockpitPanel active hosted={hosted} label={label} onSession={id => opened.push(id)}/>));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.querySelector('.ck-head')!.textContent).toContain('2 need you');
    // The service stops answering
    vi.mocked(harnessApi.cockpit).mockReturnValue(new Promise(() => {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000 + READ_TIMEOUT_MS + 10); });
    expect(host.querySelector('.ck-head')!.textContent).toContain('could not be read');
    expect(host.querySelector('p.ck-empty[role="alert"]')!.textContent).toContain('no answer from the harness service in 5 s');
    // It answers again: the error goes
    vi.mocked(harnessApi.cockpit).mockResolvedValue(doc);
    await act(async () => { await vi.advanceTimersByTimeAsync(2010); });
    expect(host.querySelector('.ck-head')!.textContent).toContain('2 need you');
  } finally {
    vi.useRealTimers();
  }
});
