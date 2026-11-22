import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ConfirmDialog from './ConfirmDialog';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { HostedRow } from './SessionRow';
import { formatAge } from '../utils/agent';
import { ACTION_KIND, actionSource, ageTitle, clickable, harnessChips, harnessSaw, isOld, liveFacts, named, oneView, shownUrgency, staleMarks, stillAwaits, trackPublisher, trackStateShown, trackWaits, type Named, type NeedGroup } from '../utils/cockpit';
import { harnessApi, type Cockpit, type CockpitAct, type CockpitAction, type CockpitLink, type CockpitTrack, type Hosted } from '../utils/harness';

/**
 * The cockpit above the Supervisor's terminal (MCR-96): one view of tracks
 * and needs (MCR-131), each track with what it needs from the person under
 * it, and what belongs to no track first, as Unassigned. It only reads. What a session
 * published is shown as its text with who said it and when; what the harness
 * knows of a session is drawn as a chip (`ck-live`) and comes from the session
 * list at every display.
 *
 * Clicks (MCR-97) name an action by ids and the stamp on screen; the service
 * acts on its own stored text after checking it again. A click never sends:
 * a line is placed in an input box unsent and the person presses Enter. The
 * page gives no text, session, link or command to the backend.
 */

const HEIGHT_KEY = 'hs-cockpit-height';
const CLOSED_KEY = 'hs-cockpit-closed';
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 90;
/** The terminal under it keeps at least this much */
const TERMINAL_MIN = 140;

const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* the height is a convenience */ } };

/** A session's name as a link to it; plain text when it cannot be opened any more. */
function SessionLink({ who, onSession }: { who: Named; onSession: (id: string) => void }) {
  // Running by the service's word, not in the list yet: named, and not called ended
  if (!who.hosted && who.standing === 'running') return <span className="ck-session you" title={`${who.name}: not in the session list yet`}>{who.name}</span>;
  // A gone session the cockpit kept no name of is said in words, its id only in the tooltip (MCR-127)
  if (!who.hosted && who.standing === 'gone' && who.name === who.id) return <span className="ck-session gone" title={`mcr:${who.id}: the harness has no such session any more`}>a gone session</span>;
  if (!who.hosted) return <span className="ck-session gone" title={`${who.name}: ${who.standing === 'gone' ? 'the harness has no such session any more' : 'this session ended'}`}>{who.name}{who.standing === 'gone' ? ' (gone)' : ' (ended)'}</span>;
  const h = who.hosted;
  return <button type="button" className="ck-session" title={`Open ${who.name}`} onClick={() => onSession(h.id)}>{who.name}</button>;
}

/** What the harness says of a session now. */
function Live({ h }: { h: Hosted }) {
  return <>{liveFacts(h).map(f => <span key={f} className="ck-live" title="From the harness, now">{f}</span>)}</>;
}

function Stale({ marks }: { marks: string[] }) {
  return marks.length ? <span className="ck-stale" title="Published text is not checked by the harness">{marks.join(' · ')}</span> : null;
}

function ActionRow({ action: a, cockpit, hosted, label, onSession }: { action: CockpitAction; cockpit: Cockpit; hosted: Hosted[]; label: (h: Hosted) => string; onSession: (id: string) => void }) {
  const who = (id: string) => named(id, cockpit, hosted, label);
  const at = a.where?.session ? who(a.where.session) : null;
  const publisher = a.by ? who(a.by) : null;
  // An action the harness knows to be behind keeps its text and loses its urgency
  const awaits = stillAwaits(a);
  const urgency = shownUrgency(a);
  // What the harness knows of the session, on this row: merged into a published one, or how long a line stood (MCR-118)
  const chips = harnessChips(a);
  // What a click did, or why the service refused it: said on the row, in the service's words
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState(false);
  const [link, setLink] = useState<CockpitLink | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // A click names the action by ids and the stamp that is on screen; nothing of its text leaves the page
  const act = (what: CockpitAct, option?: number) => {
    if (!a.by || !a.updated || busy) return;
    setBusy(true); setSaid(null);
    Promise.resolve().then(() => harnessApi.cockpitAct(a.by!, a.id, a.updated!, what, option))
      .then(done => {
        if (!alive.current) return;
        if (done.link) setLink(done.link);
        if (done.placed) {
          setSaid({ text: `Placed in the input box of ${who(done.placed).name}, not sent. Press Enter there to send it, or delete it there.`, bad: false });
          onSession(done.placed);
        }
        if (done.opened) setSaid({ text: `Opened ${done.opened} in your browser.`, bad: false });
        if (done.copied) setSaid({ text: 'Copied. Nothing was run.', bad: false });
      })
      .catch(e => { if (alive.current) setSaid({ text: String(e), bad: true }); })
      .finally(() => { if (alive.current) setBusy(false); });
  };
  // A risk the publisher declared adds caution. "reversible" is its claim and is not repeated as a comfort
  const caution = a.risk === 'irreversible' ? 'irreversible' : a.risk === 'spend' ? `spends ${a.amount ?? ''}`.trim() : '';
  // Where a choice lands: the session the action names, else its publisher's own box
  const choiceBox = at ?? publisher;
  const from = publisher ? `from ${publisher.name}` : '';
  return (
    <li className={`ck-action${a.derived ? ' derived' : ''}${!a.derived && harnessSaw(a) ? ' merged' : ''}${awaits ? '' : ' behind'}`} data-action={a.id}>
      <div className="ck-action-head">
        {urgency && <span className={`ck-urgency ${urgency}`}>{urgency}</span>}
        {a.ownerTyped && !a.sessionEnded && <span className="ck-live answered" title="From the harness: you pressed Enter in that session's terminal after this was published. Its publisher was told to update it">you typed there {formatAge(a.ownerTyped)}</span>}
        {a.sessionEnded && <span className="ck-live answered" title="From the harness: the session this points you at has ended or is gone. Its publisher was told">its session ended</span>}
        <strong>{a.title}</strong>
        <span className="ck-kind">{ACTION_KIND[a.kind]}</span>
        {at && <SessionLink who={at} onSession={onSession}/>}
        {at?.hosted && <Live h={at.hosted}/>}
        {chips.map(c => <span key={c} className="ck-live harness" title="From the harness, now">{c}</span>)}
        {caution && <span className="ck-risk caution">{caution}</span>}
      </div>
      {a.derived && a.detail && <p className="ck-fact">{a.derived === 'wait' ? 'It registered: ' : ''}{a.detail}</p>}
      {!a.derived && a.live?.report && <p className="ck-fact">{at ? at.name : 'The session'} reported: {a.live.report.text}</p>}
      {!a.derived && a.live?.waits?.map(w => <p key={w.id} className="ck-fact">{at ? at.name : 'The session'} waits for you, past its time. It registered: {w.on}</p>)}
      {a.why && <p>{a.why}</p>}
      {/* The whole line, never cut: what is read here is what a click places */}
      {a.say && (
        <div className="ck-click">
          <p className="ck-say"><span>Line for {at ? at.name : 'that session'}:</span> <code>{a.say}</code></p>
          {clickable(a, 'say') && at?.hosted && (
            <p className="ck-buttons">
              <button type="button" className="ck-do" disabled={busy} onClick={() => act('place')}>Place in {at.name}, unsent{caution ? ` (${caution})` : ''}</button>
              <span className="ck-from">{from}. Nothing is sent: you press Enter there.</span>
            </p>
          )}
          {a.unclickable?.includes('say') && <p className="ck-source">No button: this line holds characters that are not placed by a click. Type it yourself if it is right.</p>}
          {!a.unclickable?.includes('say') && a.live?.prompt && stillAwaits(a) && <p className="ck-source">No button while {at ? at.name : 'that session'} asks at a prompt: answer it there first.</p>}
        </div>
      )}
      {a.options && (
        <div className="ck-click">
          {clickable(a, 'options') && choiceBox?.hosted ? (
            <>
              <p className="ck-buttons ck-choices">
                {a.options.map((o, i) => <button key={o} type="button" className="ck-do" disabled={busy} onClick={() => act('choose', i)}>{o}{o === a.recommended ? ' (recommended by its publisher)' : ''}</button>)}
              </p>
              <p className="ck-from">{from}. A click places <code>Decision {a.id}: …</code> with your choice in the input box of {choiceBox.name}, unsent{caution ? ` (${caution})` : ''}: you press Enter there.</p>
            </>
          ) : (
            <>
              <ul className="ck-options" aria-label="Options">{a.options.map(o => <li key={o}>{o}{o === a.recommended ? ' (recommended by its publisher)' : ''}</li>)}</ul>
              <p className="ck-source">{a.unclickable?.includes('options') ? 'No buttons: an option holds characters that are not placed by a click.' : !awaits ? 'No buttons: this is behind what happened since.' : a.live?.prompt ? `No buttons while ${at ? at.name : 'that session'} asks at a prompt: answer it there first.` : 'No buttons: the session to answer in does not run.'} Answer in {choiceBox ? choiceBox.name : 'the publishing session'} yourself.</p>
            </>
          )}
        </div>
      )}
      {a.where?.command && (
        <div className="ck-click">
          <p className="ck-say"><span>Command, for you to run yourself:</span> <code>{a.where.command}</code></p>
          {clickable(a, 'command') && <p className="ck-buttons"><button type="button" className="ck-do" disabled={busy} onClick={() => act('copy')}>Copy</button><span className="ck-from">{from}. It is copied, never run.</span></p>}
        </div>
      )}
      {a.where?.url && (
        <div className="ck-click">
          <p className="ck-say"><span>Link:</span> <code>{a.where.url}</code></p>
          {clickable(a, 'url')
            ? <p className="ck-buttons"><button type="button" className="ck-do" disabled={busy} onClick={() => act('link')}>Open link…</button><span className="ck-from">{from}. You are shown where it goes first.</span></p>
            : <p className="ck-source">No button: this is not a link a click opens (https, a public host name, no port).</p>}
        </div>
      )}
      {!a.derived && (a.detail || clickable(a, 'ask')) && (
        <div className="ck-click">
          <p className="ck-buttons">
            {a.detail && <button type="button" className="ck-do quiet" aria-expanded={explain} onClick={() => setExplain(x => !x)}>{explain ? 'Hide the explanation' : 'Explain'}</button>}
            {clickable(a, 'ask') && publisher?.hosted && <button type="button" className="ck-do quiet" disabled={busy} onClick={() => act('ask')}>Ask {publisher.name} more</button>}
          </p>
          {explain && a.detail && <p className="ck-detail">{a.detail}</p>}
        </div>
      )}
      {said && <p className={said.bad ? 'ck-said bad' : 'ck-said'} role={said.bad ? 'alert' : 'status'}>{said.text}</p>}
      <p className="ck-source">
        <span className={!a.derived && isOld(a) ? 'ck-old' : undefined} title={a.derived ? undefined : ageTitle(a)}>{actionSource(a, publisher ? publisher.name : 'a session')}</span>
        {a.trackMissing && <span className="ck-stale">its track was removed</span>}
        {a.blocks?.length ? <span>blocks: {a.blocks.join(', ')}</span> : null}
        {a.source?.length ? <span>source: {a.source.join(', ')}</span> : null}
        {a.live?.reportOpen === false && <span className="ck-stale">the report it names is closed</span>}
        {!a.derived && <Stale marks={staleMarks(a, cockpit, hosted, label)}/>}
      </p>
      {/* In the page's body, not in the row: a column of the panel is a container (MCR-105), and a
          container boxes in what is fixed inside it, so the question could land out of sight */}
      {link && createPortal(
        <ConfirmDialog title="Open this link in your browser?" confirmLabel="Open link" cancelIsDefault
          onCancel={() => setLink(null)} onConfirm={() => { setLink(null); act('open'); }}>
          <dl className="ck-link">
            <dt>Host</dt><dd>{link.host}</dd>
            <dt>Path</dt><dd>{link.path || '/'}</dd>
            <dt>Query</dt><dd>{link.query || '(none)'}</dd>
          </dl>
          <p>{from ? `Published ${from}.` : ''} An agent wrote this address. A link can carry data out in its path or query, and it acts with what your browser is signed in to.</p>
          {!link.known && <p className="ck-link-warn" role="alert">Look twice: this host is not on your list of known hosts, or the path is one where you sign in, grant an app access or change an account. Open it only if you know this address and expected it.</p>}
        </ConfirmDialog>,
        document.body,
      )}
    </li>
  );
}

type Shared = { cockpit: Cockpit; hosted: Hosted[]; label: (h: Hosted) => string; onSession: (id: string) => void };

/** What the harness itself saw among a group's needs, on its header row (MCR-131): a mark, the group stays where it is. */
function Marks({ marks }: { marks: string[] }) {
  return marks.length ? <span className="ck-live harness ck-mark" title="From the harness, now: among this track's needs">{marks.join(' · ')}</span> : null;
}

/** A group's needs, under its line and items, with the publishers folded beyond the first few. */
function Needs({ group, onUnfold, ...shared }: Shared & { group: NeedGroup; onUnfold: (by: string) => void }) {
  if (!group.rows.length && !group.folded.size) return null;
  return (
    <div className="ck-track-needs">
      <ul className="ck-actions">{group.rows.map(a => <ActionRow key={`${a.by ?? ''}:${a.id}:${a.updated ?? 0}`} action={a} {...shared}/>)}</ul>
      {[...group.folded].map(([by, n]) => <button key={by} type="button" className="ck-do quiet ck-more" onClick={() => onUnfold(by)}>{n} more from {named(by, shared.cockpit, shared.hosted, shared.label).name}</button>)}
    </div>
  );
}

/** What belongs to no track: first in the view, and only when it holds a need. */
function UnassignedRow({ group, onUnfold, ...shared }: Shared & { group: NeedGroup; onUnfold: (by: string) => void }) {
  return (
    <li className="ck-track ck-unassigned" data-group="unassigned">
      <div className="ck-track-line">
        <span className="ck-expand" aria-hidden/>
        <strong className="ck-track-title">Unassigned</strong>
        <span className="ck-track-meta">
          <Marks marks={group.marks}/>
          <span className="ck-role" title="Needs that name no track, and whose session no track leads or is below the lead of">no track</span>
        </span>
      </div>
      <Needs group={group} onUnfold={onUnfold} {...shared}/>
    </li>
  );
}

function TrackRow({ track: t, group, onUnfold, cockpit, hosted, label, onSession }: Shared & { track: CockpitTrack; group: NeedGroup; onUnfold: (by: string) => void }) {
  const [open, setOpen] = useState(false);
  const who = (id: string) => named(id, cockpit, hosted, label);
  const lead = who(t.lead);
  const waits = trackWaits(t, id => who(id).name);
  const items = t.items ?? [];
  const state = trackStateShown(t);
  // Who wrote the text, when it is neither the lead nor the Supervisor whose panel this is (MCR-127)
  const publisher = trackPublisher(t);
  return (
    <li className={`ck-track ${t.state}${state.old ? ' old' : ''}`} data-track={t.id}>
      <div className="ck-track-line">
        <button type="button" className="ck-expand" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the items of ${t.title}`} disabled={!items.length} onClick={() => setOpen(o => !o)}>
          {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
        </button>
        <span className={`ck-state ${state.tone}`} title={state.tone === 'answered' ? 'From the harness: you pressed Enter in the lead session\'s terminal after this track was published as waiting for you. Its publisher was told to update it' : undefined}>{state.text}</span>
        <strong className="ck-track-title">{t.title}</strong>
        {/* Who leads and when, never cut: beside the title when both fit, else on the next line (MCR-127) */}
        <span className="ck-track-meta">
          <Marks marks={group.marks}/>
          {publisher && <span className="ck-role">lead</span>}
          <SessionLink who={lead} onSession={onSession}/>
          {publisher && <span className="ck-role">by {who(publisher).name}</span>}
          <Stale marks={staleMarks(t, cockpit, hosted, label)}/>
          {t.updated ? <span className={state.old ? 'ck-age ck-old' : 'ck-age'} title={ageTitle(t)}>{formatAge(t.updated)}</span> : null}
        </span>
      </div>
      {t.line && <p className="ck-track-text">{t.line}</p>}
      {waits.length > 0 && <p className="ck-track-text ck-track-waits">waits on {waits.join(', ')}</p>}
      {open && (
        <div className="ck-track-body">
          {lead.hosted && (() => {
            const h = lead.hosted;
            return <button type="button" className="ck-lead" title={`Open ${lead.name}`} onClick={() => onSession(h.id)}><HostedRow hosted={h} label={lead.name}/></button>;
          })()}
          {t.refs?.length ? <p className="ck-source">refs: {t.refs.join(', ')}</p> : null}
          <ul>
            {items.map(item => {
              const owner = item.owner === 'human' ? null : who(item.owner);
              const w = item.waitsOn;
              return (
                <li key={item.id} className={`ck-item ${item.state}`}>
                  <span className={`ck-state ${item.state}`}>{item.state}</span>
                  <span className="ck-item-title">{item.ref ? `${item.ref} ` : ''}{item.title}</span>
                  {owner ? <SessionLink who={owner} onSession={onSession}/> : <span className="ck-session you">you</span>}
                  {w && (w.derived
                    ? <span className={`ck-live${w.overdue ? ' late' : ''}`} title="A wait the session registered with the harness">waits for {w.what}{w.overdue ? ' (late)' : ''}{w.since ? ` · ${formatAge(w.since)}` : ''}</span>
                    : <span className="ck-waits">waits on {w.kind === 'human' ? 'you' : w.kind === 'session' && w.who ? who(w.who).name : w.what || w.kind}{(w.kind === 'human' || w.kind === 'session') && w.what ? `: ${w.what}` : ''}{w.since ? ` · ${formatAge(w.since)}` : ''}</span>)}
                  {item.next && <span className="ck-line" title={`next: ${item.next}`}>next: {item.next}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <Needs group={group} onUnfold={onUnfold} cockpit={cockpit} hosted={hosted} label={label} onSession={onSession}/>
    </li>
  );
}

/**
 * `hosted` is the Live list as it is now; `label` names a session as the list
 * does; `onSession` opens one. The cockpit document is asked for while
 * `active`, as often as the list.
 */
/** How long a read of the cockpit may take before the panel says it could not be read (MCR-118). */
export const READ_TIMEOUT_MS = 5000;

export default function CockpitPanel({ active, hosted, label, onSession }: { active: boolean; hosted: Hosted[]; label: (h: Hosted) => string; onSession: (id: string) => void }) {
  const [cockpit, setCockpit] = useState<Cockpit | null>(null);
  const [error, setError] = useState('');
  const [closed, setClosed] = useState(() => stored(CLOSED_KEY) === '1');
  const [height, setHeight] = useState(() => { const n = Number(stored(HEIGHT_KEY)); return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT; });
  const box = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    // Only the newest read may change what is shown: one that hung and answers late is older than what came since
    let started = 0; let shown = 0;
    const load = () => {
      const n = ++started;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A read that hangs is said, never covered by the last good one: "nothing needs you" is a claim
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer from the harness service in ${READ_TIMEOUT_MS / 1000} s`)), READ_TIMEOUT_MS); });
      Promise.race([Promise.resolve().then(() => harnessApi.cockpit()), late])
        .then(c => { if (live && n > shown) { shown = n; setCockpit(c && Array.isArray(c.tracks) && Array.isArray(c.actions) ? { ...c, sessions: c.sessions ?? {} } : null); setError(''); } })
        .catch(e => { if (live && n > shown) { shown = n; setError(String(e instanceof Error ? e.message : e)); } })
        .finally(() => clearTimeout(timer));
    };
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [active]);

  const toggle = () => setClosed(c => { store(CLOSED_KEY, c ? '0' : '1'); return !c; });
  const resize = useCallback((clientY: number) => {
    const el = box.current;
    const room = el?.parentElement?.getBoundingClientRect().height ?? 0;
    if (!el) return;
    const next = Math.round(Math.max(MIN_HEIGHT, Math.min(clientY - el.getBoundingClientRect().top, Math.max(MIN_HEIGHT, room - TERMINAL_MIN))));
    setHeight(next); store(HEIGHT_KEY, String(next));
  }, []);

  // Publishers whose rows beyond the first few were unfolded
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const unfold = (by: string) => setUnfolded(u => new Set([...u, by]));
  const view = cockpit ? oneView(cockpit, hosted, unfolded) : null;
  const actions = view?.all ?? [];
  const tracks = cockpit?.tracks ?? [];
  const shared = { cockpit: cockpit!, hosted, label, onSession };
  // "Nothing needs you" is a claim: made only on a cockpit that was read, and read without an error just now
  // Counted: what still stands, over every track and Unassigned. An action you already typed for is shown, and not counted
  const open = actions.filter(stillAwaits).length;
  const count = error ? 'could not be read' : !cockpit ? 'reading…' : open ? `${open} need${open === 1 ? 's' : ''} you` : actions.length ? 'nothing new needs you' : 'nothing needs you';
  return (
    <>
      <section ref={box} className={`ck-panel${closed ? ' closed' : ''}`} aria-label="Cockpit" style={closed ? undefined : { height }}>
        <header className="ck-head">
          <button type="button" className="ck-expand" aria-expanded={!closed} aria-label={closed ? 'Show the cockpit' : 'Hide the cockpit'} onClick={toggle}>
            {closed ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}
          </button>
          <strong>Cockpit</strong>
          <span className={error || open ? 'ck-count needs' : 'ck-count'} role={error ? 'alert' : undefined}>{count}</span>
          {cockpit && <span className="ck-count">{error ? 'last read: ' : ''}{error && actions.length ? `${actions.length} needed you, ` : ''}{tracks.length} track{tracks.length === 1 ? '' : 's'}</span>}
          {cockpit?.updated ? <span className="ck-age" title="When a session last published">published {formatAge(cockpit.updated)}</span> : null}
        </header>
        {!closed && (
          <div className="ck-body">
            {error && <p className="ck-empty" role="alert">The cockpit could not be read: {error}</p>}
            {cockpit && !actions.length && !tracks.length && <p className="ck-empty">Nothing is published yet. A session publishes its track with cockpit_publish; a prompt or an open report shows here by itself.</p>}
            {/* One list (MCR-131): each track with its needs under it, what belongs to no track first */}
            {view && (view.unassigned || tracks.length > 0) && <div className="ck-col">
              <h3>Tracks and needs</h3>
              <ul className="ck-tracks">
                {view.unassigned && <UnassignedRow group={view.unassigned} onUnfold={unfold} {...shared}/>}
                {tracks.map((t, i) => <TrackRow key={`${t.by}:${t.id}`} track={t} group={view.tracks[i]} onUnfold={unfold} {...shared}/>)}
              </ul>
            </div>}
          </div>
        )}
      </section>
      {!closed && <div className="ck-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize the cockpit" title="Drag to resize the cockpit"
        onPointerDown={e => { if (e.button === 0) { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); } }}
        onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) resize(e.clientY); }}/>}
    </>
  );
}
