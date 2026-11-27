import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ExternalLink, Inbox, MessageSquareShare, PlugZap, RefreshCw, Send } from 'lucide-react';
import { create } from 'zustand';
import { Pane, usePane, useSurfaceShown, type PaneType } from '@lambda-house/workbench';
import { Button, keepSame } from '@lambda-house/ui';
import { canUnlockStore, harnessApi, hostedLabel, isSupervisor, secretStoreName, slackApi, SLACK_POSTING, vaultApi, type Hosted, type SlackChannel, type SlackPolicy, type SlackPost, type SlackPosting, type SlackStatus } from '../utils/harness';
import { PLATFORM } from '../utils/platform';
import { isTauri } from '../utils/tauri';
import { formatAge } from '../utils/agent';
import { sharedPoll } from '../utils/sharedPoll';
import { useSessionsView } from '../sessionsView';
import { PANEL_MIN } from './BoardView';
import '../styles/harness.css';

// The Slack connector as four panes of Sessions' layouts: posts that wait for
// the person, the posts sessions asked for, what was received, and the
// connection with the policy of each channel. Text here is written by agents
// and by people in Slack: it is shown, never acted on. The panes show one
// state, read every few seconds while one of them is on screen; a change is
// made one at a time, and its answer is the new state.

const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const LINK: Record<SlackStatus['link'], string> = { off: 'Off', connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', refused: 'Refused by Slack', unreadable: 'Not listening' };
const STATE: Record<SlackPost['state'], string> = {
  waiting: 'waiting for you', approved: 'allowed, being sent', sending: 'being sent', sent: 'sent', denied: 'denied', cancelled: 'cancelled', failed: 'not sent', unknown: 'outcome unknown, being looked up',
};
const ALLOWED_BY: Record<string, string> = { app: 'you, in the app', slack: 'you, in Slack', 'policy:auto': "the channel's policy", 'policy:thread': "the channel's policy for thread replies" };

interface SlackFeed {
  status: SlackStatus | null;
  hosted: Hosted[];
  error: string;
  /** A change is on its way. */
  busy: boolean;
  /** Posts that wait for the person's approval: on the Slack tab from every view. */
  waiting: number;
}

export const useSlack = create<SlackFeed>(() => ({ status: null, hosted: [], error: '', busy: false, waiting: 0 }));
// A status read before a change was made must not undo its answer
let statusVersion = 0;
let changing = false;

const show = (s: SlackStatus | null) => {
  if (s) useSlack.setState(held => ({ status: keepSame(held.status, s), waiting: s.counts.waiting }));
};

export async function refreshSlack(): Promise<void> {
  const failed = (e: unknown) => useSlack.setState({ error: err(e) });
  const version = ++statusVersion;
  await Promise.all([
    slackApi.status().then(s => { if (!changing && version === statusVersion) show(s); }).catch(failed),
    harnessApi.list().then(list => useSlack.setState(held => ({ hosted: keepSame(held.hosted, list) }))).catch(failed),
  ]);
}

/** One change at a time; the answer is the new state. */
function run(work: () => Promise<SlackStatus | null>) {
  if (changing) return;
  changing = true;
  useSlack.setState({ busy: true, error: '' });
  work().then(show).catch(e => useSlack.setState({ error: err(e) })).finally(() => {
    statusVersion++;
    changing = false;
    useSlack.setState({ busy: false });
  });
}

/** What the person decided elsewhere (the Slack tab's count, read while no Slack pane is shown). */
export const setSlackWaiting = (waiting: number) => useSlack.setState({ waiting });

const useSlackPoll = sharedPoll(refreshSlack, 3000);

/** The Slack state while this pane is on screen. */
function useSlackFeed(): SlackFeed {
  const pane = usePane();
  const shown = useSurfaceShown() && (pane?.visible ?? true);
  useEffect(() => { if (!isTauri()) useSlack.setState({ error: 'Open the desktop app to use Slack.' }); }, []);
  useSlackPoll(shown && isTauri());
  return useSlack();
}

/** A Slack pane: its line under the title, the error, and what it shows once the state is read. */
function SlackPane({ label, title, about, children }: { label: string; title: string; about: React.ReactNode; children: (status: SlackStatus) => React.ReactNode }) {
  const { status, error } = useSlackFeed();
  return <Pane as="section" className="hs-board hs-slack" aria-label={label} title={title}>
    <div className="hs-panel-body">
      <header className="hs-board-head"><small>{about}</small></header>
      {error && <div className="hs-error" role="alert">{error}</div>}
      {status ? children(status) : !error && <p className="hs-empty">Loading…</p>}
    </div>
  </Pane>;
}

/** A post that waits: the exact text, which the person may change before approving. */
function Waiting({ post, busy, onDecide, onOpen, live }: { post: SlackPost; busy: boolean; live: boolean; onDecide: (approve: boolean, text?: string, reason?: string) => void; onOpen: () => void }) {
  const [text, setText] = useState(post.text);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const edited = text.trim() !== post.text;
  return <li className="open hs-slack-waiting">
    <div className="hs-board-row">
      <span className="hs-dot waiting" aria-label="Waiting for you"/>
      <span className="hs-item-text">
        <strong>{post.sessionName} → #{post.channelName}<em>{post.threadTs ? 'reply in a thread' : 'new message'}</em></strong>
        <textarea aria-label={`Text of the post by ${post.sessionName}`} value={text} rows={Math.min(10, Math.max(2, text.split('\n').length))} maxLength={3500} onChange={e => setText(e.target.value)}/>
        <small>Asked {formatAge(post.created)} · sent as the bot, exactly as shown here, with the session's name under it{edited ? ' · you changed the text' : ''}</small>
        {denying
          ? <span className="hs-slack-actions">
              <input aria-label="Why (told to the session)" placeholder="Why? The session is told (optional)" value={reason} maxLength={500} autoFocus onChange={e => setReason(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') onDecide(false, undefined, reason); if (e.key === 'Escape') setDenying(false); }}/>
              <Button variant="destructive" size="xs" disabled={busy} onClick={() => onDecide(false, undefined, reason)}>Deny</Button>
              <Button variant="secondary" size="xs" onClick={() => setDenying(false)}>Back</Button>
            </span>
          : <span className="hs-slack-actions">
              <Button variant="primary" size="xs" disabled={busy || !text.trim()} onClick={() => onDecide(true, edited ? text : undefined)}>{edited ? 'Approve as changed' : 'Approve'}</Button>
              <Button variant="secondary" size="xs" disabled={busy} onClick={() => setDenying(true)}>Deny…</Button>
              {live && <button type="button" className="hs-slack-link" onClick={onOpen}>Open session <ArrowRight size={11}/></button>}
            </span>}
      </span>
    </div>
  </li>;
}

/** Posts that wait for the person: sent only after the person approves their exact text. */
export function SlackWaitingPanel() {
  const { status, hosted, busy } = useSlack();
  const c = status?.connection;
  const running = useMemo(() => new Set(hosted.filter(h => !h.exit).map(h => h.id)), [hosted]);
  const waiting = useMemo(() => [...status?.posts ?? []].filter(p => p.state === 'waiting').reverse(), [status]);
  const onOpen = useSessionsView.getState().openLive;
  return <SlackPane label="Waiting for you" title="Waiting for you" about={`A post is sent only after you approve its exact text${c?.approveInSlack ? ', here or in your direct messages with the bot' : ''}`}>
    {() => <>
      {!waiting.length && <p className="hs-empty">{c ? 'Nothing waits. A session asks here when it wants to post where the channel’s policy says "Ask me each time".' : 'Connect Slack first.'}</p>}
      <ul>{waiting.map(p => <Waiting key={p.id} post={p} busy={busy} live={running.has(p.session)} onOpen={() => onOpen(p.session)}
        onDecide={(approve, text, reason) => run(() => slackApi.decide(p.id, approve, text, reason))}/>)}</ul>
    </>}
  </SlackPane>;
}

/** What sessions asked to post, newest first, and what became of it. */
export function SlackPostsPanel() {
  const status = useSlack(s => s.status);
  const earlier = useMemo(() => (status?.posts ?? []).filter(p => p.state !== 'waiting').slice(0, 30), [status]);
  const openLink = (url: string) => { void import('@tauri-apps/api/core').then(({ invoke }) => invoke('open_external', { url })).catch(e => useSlack.setState({ error: err(e) })); };
  return <SlackPane label="Posts" title="Posts" about="What sessions asked to post, newest first">
    {() => <>
      {!earlier.length && <p className="hs-empty">No posts yet.</p>}
      <ul>{earlier.map(p => <li key={p.id}><div className="hs-board-row">
        <span className={`hs-dot ${p.state === 'sent' ? 'idle' : p.state === 'failed' || p.state === 'denied' ? 'failed' : 'working'} past`} aria-hidden/>
        <span className="hs-item-text">
          <strong>{p.sessionName} → #{p.channelName}<em>{STATE[p.state] ?? p.state}</em></strong>
          <span className="hs-board-text">{p.text}</span>
          <small>{formatAge(p.created)}{p.allowedBy && p.state !== 'denied' ? ` · allowed by ${ALLOWED_BY[p.allowedBy] ?? p.allowedBy}` : ''}{p.reason ? ` · ${p.reason}` : ''}
            {p.link && <> · <button type="button" className="hs-slack-link" onClick={() => openLink(p.link!)}>Open in Slack <ExternalLink size={10}/></button></>}</small>
        </span>
      </div></li>)}</ul>
    </>}
  </SlackPane>;
}

/** Messages from listened channels, and where each went. */
export function SlackReceivedPanel() {
  const hosted = useSlack(s => s.hosted);
  const sessionName = (id?: string | null) => { const h = hosted.find(x => x.id === id); return h ? hostedLabel(h) : 'a session that ended'; };
  return <SlackPane label="Received" title="Received" about="Messages from listened channels, and where they went">
    {status => <>
      {!status.received.length && <p className="hs-empty">Nothing received yet. Set a channel to listen, then write there.</p>}
      <ul>{status.received.slice(0, 40).map(r => <li key={r.key} className={r.held ? '' : 'open'}><div className="hs-board-row">
        <span className={`hs-dot ${r.held ? 'failed past' : 'idle'}`} aria-hidden/>
        <span className="hs-item-text">
          <strong>#{r.channelName} · {r.userName || r.user}{r.held ? <em>not delivered</em> : null}</strong>
          <span className="hs-board-text">{r.text}</span>
          <small>{formatAge(r.at)}{r.caughtUp ? ' · read back after a gap' : ''}{r.cut ? ' · a long text, cut here' : ''} · {r.held ?? `delivered to ${sessionName(r.session)}`}</small>
        </span>
      </div></li>)}</ul>
    </>}
  </SlackPane>;
}

function ChannelPolicy({ channel, status, sessions, busy, onChange }: { channel: SlackChannel; status: SlackStatus; sessions: Hosted[]; busy: boolean; onChange: (policy: SlackPolicy) => void }) {
  const [adding, setAdding] = useState('');
  const routed = channel.route.kind === 'session' ? channel.route.session : channel.route.kind;
  const gone = channel.route.kind === 'session' && !sessions.some(h => h.id === channel.route.session);
  const everyone = channel.posters.includes('*');
  const name = (user: string) => status.users[user] || user;
  const addSender = () => {
    const id = adding.trim().toUpperCase();
    if (!/^[UW][A-Z0-9]{5,}$/.test(id) || channel.senders.includes(id)) return;
    onChange({ senders: [...channel.senders, id] });
    setAdding('');
  };
  return <li className="hs-slack-channel">
    <strong>{channel.private ? '🔒 ' : '#'}{channel.name}{!channel.member && <em>the bot is no longer a member</em>}{channel.skipped && <em title="More messages arrived while disconnected than are read back">older messages were skipped</em>}</strong>
    {channel.routeProblem && <p className="hs-slack-warning" role="status">{channel.routeProblem}. A message that arrives now is kept under Received and delivered to nobody; choose who gets them under Deliver to.</p>}
    <label>Listen
      <select value={channel.listen} disabled={busy || !channel.member} onChange={e => onChange({ listen: e.target.value as SlackChannel['listen'] })}>
        <option value="off">Off</option><option value="mentions">Only when the bot is mentioned</option><option value="all">Every message</option>
      </select>
    </label>
    <label>Deliver to
      <select value={gone ? '' : routed} disabled={busy} onChange={e => { const v = e.target.value; onChange(v === 'none' || v === 'supervisor' ? { route: v } : { route: 'session', session: v }); }}>
        {gone && <option value="">A session that ended</option>}
        <option value="none">Nobody</option>
        <option value="supervisor">The Supervisor</option>
        {sessions.filter(h => !isSupervisor(h)).map(h => <option key={h.id} value={h.id}>{hostedLabel(h)}</option>)}
      </select>
    </label>
    <label title="Whose messages reach the session. Others are shown here and go nowhere">From
      <span className="hs-slack-senders">
        {channel.senders.map(u => <span key={u} className="hs-slack-chip">{name(u)}{u === status.connection?.operator ? ' (you)' : <button type="button" aria-label={`Remove ${name(u)}`} disabled={busy} onClick={() => onChange({ senders: channel.senders.filter(s => s !== u) })}>×</button>}</span>)}
        <input aria-label={`Add a sender to ${channel.name} by member ID`} placeholder="Add member ID" value={adding} onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addSender(); }}/>
      </span>
    </label>
    <label>Sessions post
      <select value={channel.posting} disabled={busy || !channel.member} onChange={e => onChange({ posting: e.target.value as SlackPosting })}>
        {(Object.keys(SLACK_POSTING) as SlackPosting[]).map(p => <option key={p} value={p}>{SLACK_POSTING[p]}</option>)}
      </select>
    </label>
    {channel.posting !== 'never' && <label>Who may post
      <select value={everyone ? '*' : ''} disabled={busy} onChange={e => onChange({ posters: e.target.value === '*' ? ['*'] : [] })}>
        <option value="">The session it delivers to, and replies in its threads</option>
        <option value="*">Every session</option>
      </select>
    </label>}
  </li>;
}

/** The connection: its tokens, its state, the switches, the channels' policies and the audit. */
export function SlackConnectionPanel() {
  const { status, hosted, busy } = useSlack();
  const [bot, setBot] = useState(''); const [appToken, setAppToken] = useState(''); const [operator, setOperator] = useState('');
  const live = useMemo(() => hosted.filter(h => !h.exit), [hosted]);
  const channels = useMemo(() => [...status?.channels ?? []].sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name)), [status]);
  const c = status?.connection;
  return <SlackPane label="Connection" title="Connection" about={c ? `${c.team} · bot ${c.botName}` : 'Not connected'}>
    {status => {
      const counts = status.counts;
      const alarm = counts.sentWithoutApproval + counts.refusedApprovals + counts.deliveredFromStrangers;
      return !c ? <form className="hs-slack-connect" aria-label="Connect Slack" onSubmit={e => { e.preventDefault(); run(async () => { const s = await slackApi.connect(bot.trim(), appToken.trim(), operator.trim()); if (s) { setBot(''); setAppToken(''); } return s; }); }}>
        <p className="hs-board-help">Create a Slack app in your workspace from the manifest <b>docs/slack-app-manifest.yaml</b>, install it, and paste its two tokens. They are kept in {secretStoreName(PLATFORM)} on this computer and given to no agent.</p>
        <label>Bot token<input type="password" autoComplete="off" spellCheck={false} placeholder="xoxb-…" value={bot} onChange={e => setBot(e.target.value)}/></label>
        <label>App-level token<input type="password" autoComplete="off" spellCheck={false} placeholder="xapp-… (scope connections:write)" value={appToken} onChange={e => setAppToken(e.target.value)}/></label>
        <label>Your member ID<input autoComplete="off" spellCheck={false} placeholder="U… (your Slack profile: ⋮ > Copy member ID)" value={operator} onChange={e => setOperator(e.target.value)}/></label>
        <div><Button type="submit" variant="primary" size="xs" disabled={busy || !bot.trim() || !appToken.trim() || !operator.trim()}>{busy ? 'Checking…' : 'Connect…'}</Button></div>
      </form> : <>
        <div className="hs-slack-state">
          <span className={`hs-dot ${status.link === 'connected' ? 'idle' : status.link === 'off' ? 'past' : status.link === 'refused' || status.link === 'unreadable' ? 'failed' : 'working'}`} aria-hidden/>
          <span>{LINK[status.link]}{status.lastEvent ? ` · last event ${formatAge(status.lastEvent)}` : ''}{status.link === 'connected' ? ` · ${status.eventsSeen ?? 0} event${status.eventsSeen === 1 ? '' : 's'} received` : ''}{status.linkError ? ` · ${status.linkError}` : ''}</span>
        </div>
        {/* The keyring asks for its password itself; the service listens again within seconds */}
        {status.link === 'unreadable' && canUnlockStore(PLATFORM) && <div className="hs-slack-actions">
          <Button variant="ghost" size="xs" disabled={busy} onClick={() => run(async () => { await vaultApi.unlock(); return slackApi.status(); })}>Unlock keyring…</Button>
        </div>}
        {status.link !== 'off' && <p className="hs-slack-counts" title="What arrived from Slack since the harness service started">From Slack: {status.envelopesSeen ?? 0} frame{status.envelopesSeen === 1 ? '' : 's'}{status.lastEnvelope ? `, the last a ${status.lastEnvelope}` : ''} · {status.eventsSeen ?? 0} events · {status.actionsSeen ?? 0} button presses{status.lastDropped ? ` · last event not kept: ${status.lastDropped}` : ''}</p>}
        {(c.missingScopes?.length ?? 0) > 0 && <p className="hs-slack-warning" role="alert">
          The Slack app lacks {c.missingScopes!.length === 1 ? 'a permission' : 'permissions'} this needs: <b>{c.missingScopes!.join(', ')}</b>. Add {c.missingScopes!.length === 1 ? 'it' : 'them'} in the Slack app under OAuth &amp; Permissions &gt; Bot Token Scopes, reinstall the app to the workspace, then press Channels. Or recreate the app from docs/slack-app-manifest.yaml.
        </p>}
        {status.link === 'connected' && !status.eventsSeen && channels.some(ch => ch.member && ch.listen !== 'off') && <p className="hs-slack-warning">
          Connected, but Slack has sent no event yet. If you wrote in a listened channel and nothing shows under Received, the Slack app is not subscribed to events: in the Slack app open Event Subscriptions, turn it on, and under "Subscribe to bot events" add <b>message.channels</b>, <b>message.groups</b>, <b>app_mention</b> and <b>member_joined_channel</b>; Socket Mode must be on. Save, and reinstall the app if Slack asks.
        </p>}
        {status.storeError && <p className="hs-slack-warning" role="alert">
          The Slack state could not be saved on this Mac ({status.storeError}). Nothing is sent or delivered until it can be saved; what you decide meanwhile is lost if the harness service restarts.
        </p>}
        {status.link !== 'off' && status.catchUpWait && status.catchUpWait.channels.length > 0 && <p className="hs-slack-warning" role="status">
          Slack asked to wait before it gives the history of {status.catchUpWait.channels.map(n => `#${n}`).join(', ')}. What was written there while disconnected is read back {status.catchUpWait.until > Date.now() ? `at ${new Date(status.catchUpWait.until).toLocaleTimeString()}` : 'shortly'}; until then it may be missing under Received.
        </p>}
        <label className="hs-slack-toggle"><input type="checkbox" checked={status.enabled} disabled={busy} onChange={e => run(() => slackApi.enable(e.target.checked))}/>
          Slack is on <small>Off: nothing is received, nothing is sent, and posts that wait are cancelled</small></label>
        <label className="hs-slack-toggle"><input type="checkbox" checked={c.approveInSlack} disabled={busy} onChange={e => run(() => slackApi.approval(e.target.checked))}/>
          Approve in Slack too <small>Off unless you switch it on: posts are approved here. When on, the bot sends {c.operatorName || c.operator} a direct message with Approve and Deny for every post that waits. Its text is then in that direct message, also when you deny it</small></label>
        <div className="hs-slack-actions">
          <Button variant="ghost" size="xs" icon={<RefreshCw size={11}/>} disabled={busy} onClick={() => run(slackApi.refresh)} title="Read again which channels the bot is a member of">Channels</Button>
          <Button variant="ghost" size="xs" disabled={busy} onClick={() => run(slackApi.disconnect)}>Disconnect…</Button>
        </div>
        <p className={`hs-slack-counts${alarm ? ' alarm' : ''}`} title="These must stay at zero">
          Sent without approval: <b>{counts.sentWithoutApproval}</b> · approvals refused: <b>{counts.refusedApprovals}</b> · delivered from senders off the list: <b>{counts.deliveredFromStrangers}</b>
        </p>

        <header className="hs-board-head"><h2>Channels</h2><small>The bot sees only channels it was invited to: /invite @{c.botName}</small></header>
        {!channels.length && <p className="hs-empty">The bot is in no channel yet. Invite it in Slack, then press Channels.</p>}
        <ul>{channels.map(ch => <ChannelPolicy key={ch.id} channel={ch} status={status} sessions={live} busy={busy} onChange={policy => run(() => slackApi.policy(ch.id, policy))}/>)}</ul>

        <details className="hs-slack-audit"><summary>Audit ({status.audit.length})</summary>
          <ul>{status.audit.map((a, i) => <li key={`${a.at}-${i}`}><small>{new Date(a.at).toLocaleTimeString()} · {a.kind}</small> {a.text}</li>)}</ul>
        </details>
      </>;
    }}
  </SlackPane>;
}

/** Slack's panes: in every layout of Sessions, offered in the type menus and the empty pane. */
export const slackPanes: PaneType[] = [
  { type: 'slack-waiting', label: 'Slack posts waiting for you', title: 'Waiting for you', icon: <MessageSquareShare size={14}/>, switchable: true, singleton: true, min: PANEL_MIN, render: () => <SlackWaitingPanel/> },
  { type: 'slack-posts', label: 'Slack posts', title: 'Posts', icon: <Send size={14}/>, switchable: true, singleton: true, min: PANEL_MIN, render: () => <SlackPostsPanel/> },
  { type: 'slack-received', label: 'received Slack messages', title: 'Received', icon: <Inbox size={14}/>, switchable: true, singleton: true, min: PANEL_MIN, render: () => <SlackReceivedPanel/> },
  { type: 'slack-connection', label: 'Slack connection', title: 'Connection', icon: <PlugZap size={14}/>, switchable: true, singleton: true, min: PANEL_MIN, render: () => <SlackConnectionPanel/> },
];
