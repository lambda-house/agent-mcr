import { useEffect, useState } from 'react';
import { compact, sessionApi, type Session } from '../utils/sessions';
import type { Hosted } from '../utils/harness';

const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
const percent = (part: number, whole: number) => whole > 0 ? `${Math.round(100 * part / whole)}%` : '';

/** Tools by what they returned, largest first; ties by calls. */
export function toolRows(s: Session): { name: string; calls: number; bytes: number }[] {
  const bytes = s.context?.toolBytes ?? {};
  return [...new Set([...Object.keys(s.tools), ...Object.keys(bytes)])]
    .map(name => ({ name, calls: s.tools[name] ?? 0, bytes: bytes[name] ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes || b.calls - a.calls);
}

/**
 * What the selected session spent and what fills its context, read from its
 * transcript by the Sessions index (so it needs the Sessions grant and is one
 * model response behind). Tool output is shown in bytes: transcripts record
 * no tokens per tool.
 */
export default function SessionStats({ session, active }: { session: Hosted; active: boolean }) {
  const provider = session.harness?.profile || session.meta.profile || '';
  const id = session.harness?.agentSession || '';
  const [stats, setStats] = useState<Session | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    setStats(null); setNote('');
    if (!active || !id || (provider !== 'claude' && provider !== 'codex')) return;
    let live = true;
    const load = () => sessionApi.stats(provider, id)
      .then(s => { if (live) { setStats(s); setNote(''); } })
      .catch(e => { if (live) setNote(err(e)); });
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => { live = false; clearInterval(timer); };
  }, [active, provider, id]);

  const body = () => {
    if (provider !== 'claude' && provider !== 'codex') return <p className="hs-stats-note">A shell has no usage to show.</p>;
    if (!id) return <p className="hs-stats-note">No conversation yet: figures appear after the first reply.</p>;
    if (!stats) {
      if (note.includes('Enable session access')) return <p className="hs-stats-note">Usage is read from the session's transcript. Turn on session access in the History view to see it.</p>;
      return <p className="hs-stats-note">{note && !note.includes('Not indexed') ? note : 'Reading the transcript…'}</p>;
    }
    const c = stats.context ?? { now: 0, first: 0, peak: 0, window: 0, compactions: 0, toolBytes: {}, skills: {} };
    const u = stats.usage;
    const tools = toolRows(stats);
    const most = Math.max(1, ...tools.map(t => t.bytes));
    const skills = Object.entries(c.skills).sort((a, b) => b[1] - a[1]);
    const models = Object.entries(stats.models).filter(([name]) => name);
    const scale = c.window || c.peak;
    return <>
      <section>
        <h4>Context</h4>
        <p className="hs-stats-big">{compact(c.now)}<small>{c.window ? ` of ${compact(c.window)} · ${percent(c.now, c.window)}` : ' tokens now'}</small></p>
        {scale > 0 && <div className="hs-stats-bar" role="img" aria-label={c.window ? `${percent(c.now, c.window)} of the context window` : `${percent(c.now, c.peak)} of this session's peak`}><span style={{ width: `${Math.min(100, 100 * c.now / scale)}%` }}/></div>}
        <dl>
          <dt title="Input of the first reply: instructions, tool definitions and skill listings, before any work">At start</dt><dd>{compact(c.first)}</dd>
          <dt>Peak</dt><dd>{compact(c.peak)}</dd>
          <dt>Compactions</dt><dd>{c.compactions}</dd>
        </dl>
      </section>
      <section>
        <h4>Tokens{stats.usageKnown ? '' : ' (not recorded)'}</h4>
        <dl>
          <dt>Input</dt><dd>{compact(u.input)}</dd>
          <dt title="Part of the input served from the prompt cache">from cache</dt><dd>{compact(u.cached)}{u.input ? ` · ${percent(u.cached, u.input)}` : ''}</dd>
          {u.cacheWrite > 0 && <><dt>cache written</dt><dd>{compact(u.cacheWrite)}</dd></>}
          <dt>Output</dt><dd>{compact(u.output)}</dd>
          {u.reasoning > 0 && <><dt title="Part of the output">reasoning</dt><dd>{compact(u.reasoning)}</dd></>}
        </dl>
        {models.length > 1 && <dl>{models.map(([name, m]) => <span key={name} className="hs-stats-row"><dt>{name}</dt><dd>{compact(m.input + m.output)}</dd></span>)}</dl>}
      </section>
      <section>
        <h4 title="Calls, and the size of what each tool returned into the context. Bytes, not tokens: transcripts record no tokens per tool.">Tools · calls · returned</h4>
        {tools.length === 0 ? <p className="hs-stats-note">No tool calls yet.</p> : <ul>
          {tools.slice(0, 14).map(t => <li key={t.name} title={`${t.name}: ${t.calls} calls, ${size(t.bytes)} returned`}>
            <span className="hs-stats-name">{t.name}</span><span>{t.calls}</span><span>{size(t.bytes)}</span>
            <i style={{ width: `${100 * t.bytes / most}%` }}/>
          </li>)}
          {tools.length > 14 && <li className="hs-stats-more">{tools.length - 14} more</li>}
        </ul>}
      </section>
      {skills.length > 0 && <section>
        <h4 title="Skills the agent invoked; whether they did their job is not recorded">Skills invoked</h4>
        <ul>{skills.map(([name, n]) => <li key={name}><span className="hs-stats-name">{name}</span><span>{n}</span></li>)}</ul>
      </section>}
      <p className="hs-stats-note">From the transcript, as of the last reply.</p>
    </>;
  };

  return <aside className="hs-stats" aria-label="Session usage">{body()}</aside>;
}
