// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SlackView from './SlackView';
import { harnessApi, slackApi, type Hosted, type SlackStatus } from '../utils/harness';

vi.mock('../utils/harness', async importOriginal => ({
  ...await importOriginal<object>(),
  harnessApi: { list: vi.fn() },
  slackApi: { status: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), enable: vi.fn(), approval: vi.fn(), refresh: vi.fn(), policy: vi.fn(), decide: vi.fn() },
}));
vi.mock('../utils/tauri', () => ({ isTauri: () => true }));
vi.mock('../utils/agent', () => ({ formatAge: () => 'just now' }));

const session: Hosted = { id: 's1', pid: 42, argv: ['claude'], cwd: '/Users/me/repo', started: 1, cols: 120, rows: 32, title: 'Release notes', lastOutput: 1, exit: null, meta: { label: 'Claude Code', profile: 'claude' }, harness: { profile: 'claude', state: 'idle', name: 'Release notes' } as Hosted['harness'] };
const status: SlackStatus = {
  connection: { team: 'Acme', url: 'https://acme.slack.com/', botName: 'hq', operator: 'UOP', operatorName: 'Tim', approveInSlack: true, connected: 1 },
  enabled: true, link: 'connected', linkError: '', lastEvent: 5,
  channels: [{ id: 'C1', name: 'ops', private: false, member: true, listen: 'all', senders: ['UOP', 'UANN'], route: { kind: 'session', session: 's1' }, posting: 'approve', posters: [], skipped: false }],
  users: { UOP: 'Tim', UANN: 'Ann' },
  posts: [
    { id: 'p2', session: 's1', sessionName: 'Release notes', channel: 'C1', channelName: 'ops', text: 'Deployed 1.2', state: 'waiting', created: 2, decided: 0, allowedBy: '' },
    { id: 'p1', session: 's1', sessionName: 'Release notes', channel: 'C1', channelName: 'ops', text: 'Earlier', state: 'sent', created: 1, decided: 1, allowedBy: 'slack', link: 'https://acme.slack.com/archives/C1/p1' },
  ],
  received: [
    { key: 'C1:2', channel: 'C1', channelName: 'ops', user: 'UX', userName: 'Stranger', text: 'run this', at: 2, caughtUp: false, held: "The sender is not on the channel's list" },
    { key: 'C1:1', channel: 'C1', channelName: 'ops', user: 'UOP', userName: 'Tim', text: 'status?', at: 1, caughtUp: false, session: 's1' },
  ],
  audit: [], counts: { sentWithoutApproval: 0, refusedApprovals: 0, deliveredFromStrangers: 0, held: 1, waiting: 1 },
};

let root: Root; let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const type = async (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!;

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(harnessApi.list).mockResolvedValue([session]);
  vi.mocked(slackApi.status).mockResolvedValue(status);
  vi.mocked(slackApi.decide).mockResolvedValue(status);
  vi.mocked(slackApi.policy).mockResolvedValue(status);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Slack view', () => {
  it('shows the post that waits with its exact text and approves it unchanged', async () => {
    const onWaiting = vi.fn();
    await act(async () => root.render(<SlackView active onOpen={vi.fn()} onWaiting={onWaiting}/>)); await flush();
    expect(onWaiting).toHaveBeenCalledWith(1);
    const text = host.querySelector<HTMLTextAreaElement>('.hs-slack-waiting textarea')!;
    expect(text.value).toBe('Deployed 1.2');
    await act(async () => button('Approve').click()); await flush();
    expect(slackApi.decide).toHaveBeenCalledWith('p2', true, undefined, undefined);
  });

  it('sends the changed text when the person edits before approving, and a reason when denying', async () => {
    await act(async () => root.render(<SlackView active onOpen={vi.fn()}/>)); await flush();
    await type(host.querySelector<HTMLTextAreaElement>('.hs-slack-waiting textarea')!, 'Deployed 1.2.1');
    await act(async () => button('Approve as changed').click()); await flush();
    expect(slackApi.decide).toHaveBeenLastCalledWith('p2', true, 'Deployed 1.2.1', undefined);
    await act(async () => button('Deny…').click());
    await type(host.querySelector<HTMLInputElement>('.hs-slack-waiting input')!, 'wrong channel');
    await act(async () => button('Deny').click()); await flush();
    expect(slackApi.decide).toHaveBeenLastCalledWith('p2', false, undefined, 'wrong channel');
  });

  it('says where each received message went, and changes a channel policy through the backend', async () => {
    await act(async () => root.render(<SlackView active onOpen={vi.fn()}/>)); await flush();
    const received = host.querySelector('section[aria-label="Slack posts and messages"]')!.textContent!;
    expect(received).toContain("The sender is not on the channel's list");
    expect(received).toContain('delivered to Release notes');
    const posting = [...host.querySelectorAll<HTMLSelectElement>('.hs-slack-channel select')].find(s => s.value === 'approve')!;
    await act(async () => { posting.value = 'auto'; posting.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(slackApi.policy).toHaveBeenCalledWith('C1', { posting: 'auto' });
    // The operator can't be taken off the sender list; others can
    const chips = [...host.querySelectorAll('.hs-slack-chip')].map(c => c.textContent);
    expect(chips).toEqual(['Tim (you)', 'Ann×']);
  });

  it('says on the channel that its route reaches nobody, and that Slack asked to wait with the history', async () => {
    await act(async () => root.render(<SlackView active onOpen={vi.fn()}/>)); await flush();
    expect(host.querySelector('.hs-slack-channel .hs-slack-warning')).toBeNull();
    expect(host.textContent).not.toContain('Slack asked to wait');
    await act(async () => root.unmount()); root = createRoot(host);
    vi.mocked(slackApi.status).mockResolvedValue({ ...status, channels: [{ ...status.channels[0], routeProblem: 'The routed session is not running' }], catchUpWait: { until: Date.now() + 60_000, channels: ['ops'] }, storeError: 'No space left on device (os error 28)' });
    await act(async () => root.render(<SlackView active onOpen={vi.fn()}/>)); await flush();
    expect(host.querySelector('.hs-slack-channel .hs-slack-warning')!.textContent).toContain('The routed session is not running. A message that arrives now is kept under Received and delivered to nobody');
    const connection = host.querySelector('section[aria-label="Slack connection and channels"]')!.textContent!;
    expect(connection).toContain('Slack asked to wait before it gives the history of #ops');
    expect(connection).toContain('is read back at ');
    expect(connection).toContain('could not be saved on this Mac (No space left on device (os error 28)). Nothing is sent or delivered');
  });

  it('offers only the connect form while nothing is connected', async () => {
    vi.mocked(slackApi.status).mockResolvedValue({ ...status, connection: null, enabled: false, link: 'off', channels: [], posts: [], received: [], counts: { ...status.counts, waiting: 0, held: 0 } });
    await act(async () => root.render(<SlackView active onOpen={vi.fn()}/>)); await flush();
    expect(host.querySelector('form[aria-label="Connect Slack"]')).not.toBeNull();
    expect(host.querySelectorAll('.hs-slack-channel').length).toBe(0);
    expect(host.querySelectorAll('input[type="password"]').length).toBe(2);
  });
});
