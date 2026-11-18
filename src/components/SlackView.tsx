import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ExternalLink, RefreshCw } from 'lucide-react';
import { harnessApi, hostedLabel, isSupervisor, slackApi, SLACK_POSTING, type Hosted, type SlackChannel, type SlackPolicy, type SlackPost, type SlackPosting, type SlackStatus } from '../utils/harness';
import { isTauri } from '../utils/tauri';
import { formatAge } from '../utils/agent';
import '../styles/harness.css';

const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const LINK: Record<SlackStatus['link'], string> = { off: 'Off', connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', refused: 'Refused by Slack' };
const STATE: Record<SlackPost['state'], string> = {
  waiting: 'waiting for you', approved: 'allowed, being sent', sending: 'being sent', sent: 'sent', denied: 'denied', cancelled: 'cancelled', failed: 'not sent', unknown: 'outcome unknown, being looked up',
};
const ALLOWED_BY: Record<string, string> = { app: 'you, in the app', slack: 'you, in Slack', 'policy:auto': "the channel's policy", 'policy:thread': "the channel's policy for thread replies" };

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
              <button type="button" disabled={busy} onClick={() => onDecide(false, undefined, reason)}>Deny</button>
              <button type="button" onClick={() => setDenying(false)}>Back</button>
            </span>
          : <span className="hs-slack-actions">
              <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => onDecide(true, edited ? text : undefined)}>{edited ? 'Approve as changed' : 'Approve'}</button>
              <button type="button" disabled={busy} onClick={() => setDenying(true)}>Deny…</button>
              {live && <button type="button" className="hs-slack-link" onClick={onOpen}>Open session <ArrowRight size={11}/></button>}
            </span>}
      </span>
    </div>
  </li>;
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

/**
 * The Slack connector: connection, the policy of each channel, posts that wait
 * for the person, and what was received. Text here is written by agents and by
 * people in Slack: it is shown, never acted on.
 */
export default function SlackView({ active, onOpen, onWaiting }: { active: boolean; onOpen: (id: string) => void; onWaiting?: (count: number) => void }) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [hosted, setHosted] = useState<Hosted[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bot, setBot] = useState(''); const [appToken, setAppToken] = useState(''); const [operator, setOperator] = useState('');
  const mounted = useRef(true);

  const show = useCallback((s: SlackStatus | null) => { if (s && mounted.current) { setStatus(s); onWaiting?.(s.counts.waiting); } }, [onWaiting]);
  const refresh = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([slackApi.status(), harnessApi.list()]);
      if (mounted.current) { show(s); setHosted(list); }
    } catch (e) { if (mounted.current) setError(err(e)); }
  }, [show]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!isTauri()) { setError('Open the desktop app to use Slack.'); return; }
    if (!active) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  /** One change at a time; the answer is the new state */
  const run = (work: () => Promise<SlackStatus | null>) => {
    if (busy) return;
    setBusy(true); setError('');
    work().then(show).catch(e => { if (mounted.current) setError(err(e)); }).finally(() => { if (mounted.current) setBusy(false); });
  };
  const live = useMemo(() => hosted.filter(h => !h.exit), [hosted]);
  const running = useMemo(() => new Set(live.map(h => h.id)), [live]);
  const waiting = useMemo(() => [...status?.posts ?? []].filter(p => p.state === 'waiting').reverse(), [status]);
  const earlier = useMemo(() => (status?.posts ?? []).filter(p => p.state !== 'waiting').slice(0, 30), [status]);
  const channels = useMemo(() => [...status?.channels ?? []].sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name)), [status]);
  const sessionName = (id?: string | null) => { const h = hosted.find(x => x.id === id); return h ? hostedLabel(h) : 'a session that ended'; };

  if (!status) return <div className="hs-board">{error ? <div className="hs-error" role="alert">{error}</div> : <p className="hs-empty">Loading…</p>}</div>;
  const c = status.connection;
  const counts = status.counts;
  const alarm = counts.sentWithoutApproval + counts.refusedApprovals + counts.deliveredFromStrangers;

  return <div className="hs-board hs-slack">
    {error && <div className="hs-error" role="alert">{error}</div>}
    <section aria-label="Slack posts and messages">
      <header className="hs-board-head"><h2>Waiting for you</h2><small>A post is sent only after you approve its exact text{c?.approveInSlack ? ', here or in your direct messages with the bot' : ''}</small></header>
      {!waiting.length && <p className="hs-empty">{c ? 'Nothing waits. A session asks here when it wants to post where the channel’s policy says "Ask me each time".' : 'Connect Slack first.'}</p>}
      <ul>{waiting.map(p => <Waiting key={p.id} post={p} busy={busy} live={running.has(p.session)} onOpen={() => onOpen(p.session)}
        onDecide={(approve, text, reason) => run(() => slackApi.decide(p.id, approve, text, reason))}/>)}</ul>

      <header className="hs-board-head"><h2>Posts</h2><small>What sessions asked to post, newest first</small></header>
      {!earlier.length && <p className="hs-empty">No posts yet.</p>}
      <ul>{earlier.map(p => <li key={p.id}><div className="hs-board-row">
        <span className={`hs-dot ${p.state === 'sent' ? 'idle' : p.state === 'failed' || p.state === 'denied' ? 'failed' : 'working'} past`} aria-hidden/>
        <span className="hs-item-text">
          <strong>{p.sessionName} → #{p.channelName}<em>{STATE[p.state] ?? p.state}</em></strong>
          <span className="hs-board-text">{p.text}</span>
          <small>{formatAge(p.created)}{p.allowedBy && p.state !== 'denied' ? ` · allowed by ${ALLOWED_BY[p.allowedBy] ?? p.allowedBy}` : ''}{p.reason ? ` · ${p.reason}` : ''}
            {p.link && <> · <button type="button" className="hs-slack-link" onClick={() => { void import('@tauri-apps/api/core').then(({ invoke }) => invoke('open_external', { url: p.link })).catch(e => setError(err(e))); }}>Open in Slack <ExternalLink size={10}/></button></>}</small>
        </span>
      </div></li>)}</ul>

      <header className="hs-board-head"><h2>Received</h2><small>Messages from listened channels, and where they went</small></header>
      {!status.received.length && <p className="hs-empty">Nothing received yet. Set a channel to listen, then write there.</p>}
      <ul>{status.received.slice(0, 40).map(r => <li key={r.key} className={r.held ? '' : 'open'}><div className="hs-board-row">
        <span className={`hs-dot ${r.held ? 'failed past' : 'idle'}`} aria-hidden/>
        <span className="hs-item-text">
          <strong>#{r.channelName} · {r.userName || r.user}{r.held ? <em>not delivered</em> : null}</strong>
          <span className="hs-board-text">{r.text}</span>
          <small>{formatAge(r.at)}{r.caughtUp ? ' · read back after a gap' : ''}{r.cut ? ' · a long text, cut here' : ''} · {r.held ?? `delivered to ${sessionName(r.session)}`}</small>
        </span>
      </div></li>)}</ul>
    </section>

    <section aria-label="Slack connection and channels">
      <header className="hs-board-head"><h2>Connection</h2><small>{c ? `${c.team} · bot ${c.botName}` : 'Not connected'}</small></header>
      {!c ? <form className="hs-slack-connect" aria-label="Connect Slack" onSubmit={e => { e.preventDefault(); run(async () => { const s = await slackApi.connect(bot.trim(), appToken.trim(), operator.trim()); if (s) { setBot(''); setAppToken(''); } return s; }); }}>
        <p className="hs-board-help">Create a Slack app in your workspace from the manifest <b>docs/slack-app-manifest.yaml</b>, install it, and paste its two tokens. They are kept in the macOS Keychain on this Mac and shown to no agent.</p>
        <label>Bot token<input type="password" autoComplete="off" spellCheck={false} placeholder="xoxb-…" value={bot} onChange={e => setBot(e.target.value)}/></label>
        <label>App-level token<input type="password" autoComplete="off" spellCheck={false} placeholder="xapp-… (scope connections:write)" value={appToken} onChange={e => setAppToken(e.target.value)}/></label>
        <label>Your member ID<input autoComplete="off" spellCheck={false} placeholder="U… (your Slack profile: ⋮ > Copy member ID)" value={operator} onChange={e => setOperator(e.target.value)}/></label>
        <div><button type="submit" disabled={busy || !bot.trim() || !appToken.trim() || !operator.trim()}>{busy ? 'Checking…' : 'Connect…'}</button></div>
      </form> : <>
        <div className="hs-slack-state">
          <span className={`hs-dot ${status.link === 'connected' ? 'idle' : status.link === 'off' ? 'past' : status.link === 'refused' ? 'failed' : 'working'}`} aria-hidden/>
          <span>{LINK[status.link]}{status.lastEvent ? ` · last event ${formatAge(status.lastEvent)}` : ''}{status.link === 'connected' ? ` · ${status.eventsSeen ?? 0} event${status.eventsSeen === 1 ? '' : 's'} received` : ''}{status.linkError ? ` · ${status.linkError}` : ''}</span>
        </div>
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
          <button type="button" disabled={busy} onClick={() => run(slackApi.refresh)} title="Read again which channels the bot is a member of"><RefreshCw size={11}/> Channels</button>
          <button type="button" disabled={busy} onClick={() => run(slackApi.disconnect)}>Disconnect…</button>
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
      </>}
    </section>
  </div>;
}
