// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HostedRow, ProgramLine } from './SessionRow';
import type { Hosted } from '../utils/harness';

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const now = Date.now();
const hosted = (over: Partial<Hosted> = {}): Hosted => ({
  id: 'a', pid: 1, argv: ['claude'], cwd: '/w', started: now, cols: 80, rows: 24, title: '', lastOutput: now, exit: null, meta: { profile: 'claude' },
  harness: { name: 'build', profile: 'claude', state: 'working', since: now, precise: true, hooked: true, agentSession: null, attention: null, lastMessage: null },
  ...over,
});

it('shows what the program reports as its word under the hooks\' state, never as a state of its own (MCR-115)', async () => {
  const h = hosted({ program: { records: [{ state: 'blocked', kind: 'permission', app: 'terraform', msg: 'Apply 3 to add?', progress: 60, at: now }] } });
  await act(async () => root.render(<HostedRow hosted={h} label="build"/>));
  // One state dot, and it is the hooks'
  expect([...host.querySelectorAll('.hs-dot')].map(d => d.className)).toEqual(['hs-dot working']);
  const line = host.querySelector('.hs-program')!;
  expect(line.textContent).toBe('program terraformreportsblocked (permission) 60% · Apply 3 to add?');
  expect(line.getAttribute('title')).toContain('Not checked: any output can print this');
  expect(line.getAttribute('title')).toContain("The agent's hooks say working, and the hooks rank first.");
  // The hooks say otherwise: struck, not hidden
  expect(line.classList.contains('disagrees')).toBe(true);
  expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('60');
  // Nothing in it is a control
  expect(line.querySelector('button, a, input')).toBeNull();
  // And the row says nothing of the prompt it claims: no needs-you line
  expect(host.querySelector('.hs-needs')).toBeNull();
});

it('draws nothing for a program that said nothing, and a short form for the pane title', async () => {
  await act(async () => root.render(<HostedRow hosted={hosted()} label="build"/>));
  expect(host.querySelector('.hs-program')).toBeNull();
  await act(async () => root.render(<ProgramLine compact hosted={hosted({ program: { progress: { state: 'normal', value: 30, at: now } } })}/>));
  const compact = host.querySelector('span.hs-program.compact')!;
  expect(compact.textContent).toBe('programreportsprogress 30%');
  expect(compact.classList.contains('disagrees')).toBe(false);
});

it('labels a program that names itself as one of ours as a program, in plain weight (MCR-115 review)', async () => {
  await act(async () => root.render(<HostedRow hosted={hosted({ program: { records: [{ state: 'done', app: 'Supervisor', at: now }] } })} label="build"/>));
  const lead = host.querySelector('.hs-program-lead')!;
  expect(lead.textContent).toBe('program Supervisor');
  // Only the session's own name is in the row's bold title
  expect(host.querySelector('strong')!.textContent).not.toContain('Supervisor');
});
