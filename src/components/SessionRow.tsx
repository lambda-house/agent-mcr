import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Hourglass } from 'lucide-react';
import AgentMark from './AgentMark';
import { SessionFigures } from './SessionMetrics';
import { formatAge } from '../utils/agent';
import { formatUntil, harnessApi, heldNote, hostedState, programHint, sessionSummary, STATE_LABEL, type Hosted } from '../utils/harness';
import type { Session } from '../utils/sessions';

/**
 * The two rows of the Live list. The list itself, the Journal's results and
 * the command panel all draw a session with them, so a found session looks as
 * it does in the list: a search is the list filtered, not a second layout.
 */

/** A running session that waits for the person. */
export const needsYou = (h: Hosted) => !h.exit && !!h.harness?.attention;

/** Rows that are dimmed: idle or ended, unless something asks for the person. */
export const rowIdle = (h: Hosted) => !needsYou(h) && (hostedState(h) === 'idle' || !!h.exit) && !(!h.exit && h.shells?.length);

/** The second line of a hosted row: how it ended, or its open tasks and unread messages. */
export function hostedDetail(h: Hosted, extra = ''): string {
  return h.exit
    ? `exited ${h.exit.signal ? `by ${h.exit.signal}` : `with ${h.exit.code}`} · ${formatAge(h.exit.at)}`
    : [h.openTasks ? `${h.openTasks} task${h.openTasks > 1 ? 's' : ''}` : '', h.unread ? `${h.unread} unread` : '', heldNote(h), extra].filter(Boolean).join(' · ');
}

/**
 * What the program in the terminal said of itself (MCR-115), drawn as its
 * word and never as a state: no dot, the program's name first, "reports",
 * and the tooltip saying that nothing checked it. `compact` is for the
 * terminal pane's title.
 */
export function ProgramLine({ hosted, compact = false }: { hosted: Hosted; compact?: boolean }) {
  const hint = programHint(hosted);
  if (!hint) return null;
  const Tag = compact ? 'span' : 'small';
  return <Tag className={`hs-program${compact ? ' compact' : ''}${hint.disagrees ? ' disagrees' : ''}`} title={hint.full}>
    <span className="hs-program-lead">{hint.lead}</span>
    <span className="hs-program-says">reports</span>
    {hint.progress !== undefined && <span className="hs-program-bar" role="progressbar" aria-label={`${hint.lead} reports ${hint.progress}%`} aria-valuenow={hint.progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${hint.progress}%` }}/></span>}
    <span className="hs-program-text">{hint.text}</span>
  </Tag>;
}

/**
 * A hosted session: the state dot, the agent mark and its name, then a line
 * only for what is there (figures, tasks, a prompt, waits, the agent's status).
 */
export function HostedRow({ hosted: h, label, tooltip = label, session, detail = hostedDetail(h), before, after, under }: {
  hosted: Hosted; label: string;
  /** Shown over the name: the full name unless the row has more to say there */
  tooltip?: string;
  /** The indexed conversation, for the figures; nothing is shown without it */
  session?: Session;
  detail?: string;
  /** Marks inside the name, before the agent mark and after the name */
  before?: ReactNode; after?: ReactNode;
  /** A line right under the name */
  under?: ReactNode;
}) {
  const state = hostedState(h);
  const summary = sessionSummary(h, Date.now());
  return <>
    <span className={`hs-dot ${state}`} aria-label={STATE_LABEL[state]}/>
    <span className="hs-item-text">
      <strong title={tooltip}>{before}<AgentMark profile={h.harness?.profile || h.meta.profile || ''}/> {label}{after}</strong>
      {under}
      {session && <SessionFigures session={session} cache={!h.exit}/>}
      {detail && <small>{detail}</small>}
      {needsYou(h) && <small className="hs-needs">{h.harness?.attention?.text}</small>}
      {!h.exit && (h.waits ?? []).map(w => <small key={w.id} className={`hs-wait${w.overdue ? ' overdue' : ''}`}
        title={`Registered by the session ${formatAge(w.since)}: ${w.kind}${w.ref ? ` · ${w.ref}` : ''}\n${w.overdue ? `Expected to be over ${formatAge(w.expectBy)}${w.escalated ? `; ${w.escalated === 'operator' ? 'you were' : 'its supervisor was'} told` : ''}` : `Expected to be over ${formatUntil(w.expectBy)}`}`}>
        <Hourglass size={10}/> waits for {w.on}{w.overdue ? ' · late' : ''}</small>)}
      {summary && <small className="hs-status" title={summary.full || undefined}>{summary.lead && <span className="hs-lead">{summary.lead}</span>}{summary.text && <span>{summary.text}</span>}</small>}
      <ProgramLine hosted={h}/>
    </span>
  </>;
}

/** A conversation that is not running: the agent mark, its title and its age. */
export function EarlierRow({ agent, title, modified, note = '' }: { agent: string; title: string; modified: number; note?: string }) {
  return <>
    <span className="hs-item-text"><strong><AgentMark profile={agent}/> {title}</strong></span>
    <small>{modified ? formatAge(modified) : ''}{note}</small>
  </>;
}

/** The key of the indexed conversation a hosted session runs, as `sessionKey` gives it. */
const conversation = (h: Hosted) => `${h.harness?.profile || h.meta.profile}:${h.harness?.agentSession}`;

/**
 * The hosted sessions that run a conversation now, by the conversation's key.
 * Asked for when `active` turns on and, with `every`, again at that interval.
 */
export function useHostedByConversation(active: boolean, every = 0): Map<string, Hosted> {
  const [hosted, setHosted] = useState<Hosted[]>([]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = () => {
      Promise.resolve().then(() => harnessApi.list())
        .then(list => { if (live) setHosted(Array.isArray(list) ? list : []); })
        .catch(() => { if (live) setHosted([]); });
    };
    load();
    const timer = every ? setInterval(() => { if (!document.hidden) load(); }, every) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [active, every]);
  return useMemo(() => new Map(hosted.filter(h => !h.exit && h.harness?.agentSession).map(h => [conversation(h), h])), [hosted]);
}
