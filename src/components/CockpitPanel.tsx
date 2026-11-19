import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { HostedRow } from './SessionRow';
import { formatAge } from '../utils/agent';
import { ACTION_KIND, actionSource, liveFacts, named, needsYouRows, staleMarks, stillAwaits, trackStateShown, trackWaits, type Named } from '../utils/cockpit';
import { harnessApi, type Cockpit, type CockpitAction, type CockpitTrack, type Hosted } from '../utils/harness';

/**
 * The cockpit above the Supervisor's terminal (MCR-96): what needs the
 * person, then every track on one line. It only reads. What a session
 * published is shown as its text with who said it and when; what the harness
 * knows of a session is drawn as a chip (`ck-live`) and comes from the session
 * list at every display. Nothing here runs or types a published line: a
 * session's name opens that session, and that is the only click.
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
  if (!who.hosted && who.standing === 'running') return <span className="ck-session you" title="Not in the session list yet">{who.name}</span>;
  if (!who.hosted) return <span className="ck-session gone" title={who.standing === 'gone' ? 'The harness has no such session any more' : 'This session ended'}>{who.name}{who.standing === 'gone' ? ' (gone)' : ' (ended)'}</span>;
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
  const track = a.track ? cockpit.tracks.find(t => t.id === a.track && (!a.trackBy || t.by === a.trackBy)) : undefined;
  // An action the harness knows to be behind keeps its text and loses its urgency
  const awaits = stillAwaits(a);
  const urgency = !awaits ? '' : a.derived === 'prompt' ? 'now' : a.urgency ?? (a.derived === 'report' ? 'today' : '');
  return (
    <li className={`ck-action${a.derived ? ' derived' : ''}${awaits ? '' : ' behind'}`} data-action={a.id}>
      <div className="ck-action-head">
        {urgency && <span className={`ck-urgency ${urgency}`}>{urgency}</span>}
        {a.ownerTyped && !a.sessionEnded && <span className="ck-live answered" title="From the harness: you pressed Enter in that session's terminal after this was published. Its publisher was told to update it">you typed there {formatAge(a.ownerTyped)}</span>}
        {a.sessionEnded && <span className="ck-live answered" title="From the harness: the session this points you at has ended or is gone. Its publisher was told">its session ended</span>}
        <strong>{a.title}</strong>
        <span className="ck-kind">{ACTION_KIND[a.kind]}</span>
        {at && <SessionLink who={at} onSession={onSession}/>}
        {at?.hosted && <Live h={at.hosted}/>}
      </div>
      {a.detail && <p className={a.derived ? 'ck-fact' : undefined}>{a.detail}</p>}
      {a.why && <p>{a.why}</p>}
      {a.say && <p className="ck-say"><span>To type{at ? ` in ${at.name}` : ''}:</span> <code>{a.say}</code></p>}
      {/* A list to read, not buttons: nothing here is clicked (the clicks are MCR-97) */}
      {a.options && <ul className="ck-options" aria-label="Options">{a.options.map(o => <li key={o} className={o === a.recommended ? 'recommended' : undefined}>{o}{o === a.recommended ? ' (recommended)' : ''}</li>)}</ul>}
      {a.options && <p className="ck-source">Answer in {at ? at.name : a.by ? `the terminal of ${who(a.by).name}` : 'the publishing session'}: these are not buttons yet.</p>}
      {a.where?.command && <p className="ck-say"><span>To run yourself:</span> <code>{a.where.command}</code></p>}
      {a.where?.url && <p className="ck-say"><span>At:</span> <code>{a.where.url}</code></p>}
      <p className="ck-source">
        {actionSource(a, a.by ? who(a.by).name : 'a session')}
        {a.risk && <span className={`ck-risk ${a.risk}`}>{a.risk === 'spend' ? `spends ${a.amount ?? ''}`.trim() : a.risk}</span>}
        {track && <span>track: {track.title}</span>}
        {a.trackMissing && <span className="ck-stale">its track was removed</span>}
        {a.blocks?.length ? <span>blocks: {a.blocks.join(', ')}</span> : null}
        {a.source?.length ? <span>source: {a.source.join(', ')}</span> : null}
        {a.live && !a.live.reportOpen && <span className="ck-stale">the report it names is closed</span>}
        {!a.derived && <Stale marks={staleMarks(a, cockpit, hosted, label)}/>}
      </p>
    </li>
  );
}

function TrackRow({ track: t, cockpit, hosted, label, onSession }: { track: CockpitTrack; cockpit: Cockpit; hosted: Hosted[]; label: (h: Hosted) => string; onSession: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const who = (id: string) => named(id, cockpit, hosted, label);
  const lead = who(t.lead);
  const waits = trackWaits(t, id => who(id).name);
  const items = t.items ?? [];
  const state = trackStateShown(t);
  // Who wrote the text is not always who leads the work: the Supervisor publishes tracks led by others
  const publishedByOther = t.by !== t.lead;
  return (
    <li className={`ck-track ${t.state}${state.tone === 'stale' ? ' stale' : ''}`} data-track={t.id}>
      <div className="ck-track-line">
        <button type="button" className="ck-expand" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the items of ${t.title}`} disabled={!items.length} onClick={() => setOpen(o => !o)}>
          {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
        </button>
        <span className={`ck-state ${state.tone}`} title={state.tone === 'answered' ? 'From the harness: you pressed Enter in the lead session\'s terminal after this track was published as waiting for you. Its publisher was told to update it' : undefined}>{state.text}</span>
        <strong>{t.title}</strong>
        {publishedByOther && <span className="ck-role">lead</span>}
        <SessionLink who={lead} onSession={onSession}/>
        <Stale marks={staleMarks(t, cockpit, hosted, label)}/>
        <span className="ck-age">{publishedByOther ? `by ${who(t.by).name} · ` : ''}{t.updated ? formatAge(t.updated) : ''}</span>
      </div>
      {(t.line || waits.length > 0) && <div className="ck-track-sub">
        {t.line && <span className="ck-line">{t.line}</span>}
        {waits.length > 0 && <span className="ck-waits">waits on {waits.join(', ')}</span>}
      </div>}
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
                  {item.next && <span className="ck-line">next: {item.next}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </li>
  );
}

/**
 * `hosted` is the Live list as it is now; `label` names a session as the list
 * does; `onSession` opens one. The cockpit document is asked for while
 * `active`, as often as the list.
 */
export default function CockpitPanel({ active, hosted, label, onSession }: { active: boolean; hosted: Hosted[]; label: (h: Hosted) => string; onSession: (id: string) => void }) {
  const [cockpit, setCockpit] = useState<Cockpit | null>(null);
  const [error, setError] = useState('');
  const [closed, setClosed] = useState(() => stored(CLOSED_KEY) === '1');
  const [height, setHeight] = useState(() => { const n = Number(stored(HEIGHT_KEY)); return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT; });
  const box = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = () => {
      Promise.resolve().then(() => harnessApi.cockpit())
        .then(c => { if (live) { setCockpit(c && Array.isArray(c.tracks) && Array.isArray(c.actions) ? { ...c, sessions: c.sessions ?? {} } : null); setError(''); } })
        .catch(e => { if (live) setError(String(e)); });
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

  const actions = cockpit ? needsYouRows(cockpit) : [];
  const tracks = cockpit?.tracks ?? [];
  // "Nothing needs you" is a claim: made only on a cockpit that was read, and read without an error just now
  // Counted: what still stands. An action you already typed for is shown, and not counted
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
            {/* Side by side in a wide pane, so the tracks stay in sight under any number of actions */}
            {actions.length > 0 && <div className="ck-col">
              <h3>Needs you</h3>
              <ul className="ck-actions">{actions.map(a => <ActionRow key={`${a.by ?? ''}:${a.id}`} action={a} cockpit={cockpit!} hosted={hosted} label={label} onSession={onSession}/>)}</ul>
            </div>}
            {tracks.length > 0 && <div className="ck-col">
              <h3>Tracks</h3>
              <ul className="ck-tracks">{tracks.map(t => <TrackRow key={`${t.by}:${t.id}`} track={t} cockpit={cockpit!} hosted={hosted} label={label} onSession={onSession}/>)}</ul>
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
