import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { formatUntil, harnessApi, openReports, shortPath, tildePath, type Board, type Hosted } from '../utils/harness';
import { isTauri } from '../utils/tauri';
import { formatAge } from '../utils/agent';
import '../styles/harness.css';

const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const KIND = { needs_human: 'Needs you', done: 'Done' } as const;
type Filter = 'all' | keyof typeof KIND;

/**
 * What sessions reported to the person (their `report` tool), and the notes
 * they left for each other on the bulletin board. Text here is written by
 * agents: it is shown, never acted on.
 */
export default function BoardView({ active, onOpen }: { active: boolean; /** Show a running session in Live */ onOpen: (id: string) => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [hosted, setHosted] = useState<Hosted[]>([]);
  const [home, setHome] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // A note is removed on the second click
  const [removing, setRemoving] = useState('');
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [b, list] = await Promise.all([harnessApi.board(), harnessApi.list()]);
      if (mounted.current) { setBoard(b); setHosted(list); setError(''); }
    } catch (e) { if (mounted.current) setError(err(e)); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!isTauri()) { setError('Open the desktop app to see the board.'); return; }
    harnessApi.status().then(s => { if (mounted.current) setHome(s.home ?? ''); }).catch(() => {});
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!active || !isTauri()) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const running = useMemo(() => new Set(hosted.filter(h => !h.exit).map(h => h.id)), [hosted]);
  const open = useMemo(() => openReports(board?.reports ?? [], hosted), [board, hosted]);
  const reports = useMemo(() => [...board?.reports ?? []].reverse().filter(r => filter === 'all' || r.kind === filter), [board, filter]);
  const notes = useMemo(() => [...board?.notes ?? []].reverse(), [board]);
  const folder = (path: string) => shortPath(tildePath(path, home));
  const remove = (id: string) => {
    if (removing !== id) { setRemoving(id); setTimeout(() => setRemoving(r => r === id ? '' : r), 3000); return; }
    setRemoving('');
    harnessApi.removeNote(id).then(refresh).catch(e => setError(err(e)));
  };

  return <div className="hs-board">
    {error && <div className="hs-error" role="alert">{error}</div>}
    <section aria-label="Reports">
      <header className="hs-board-head">
        <h2>Reports</h2>
        <small>What sessions told you with their report tool</small>
        <span className="hs-board-filter" role="group" aria-label="Kind of report">
          {(['all', 'needs_human', 'done'] as Filter[]).map(f => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : KIND[f]}</button>)}
        </span>
      </header>
      {board && !reports.length && <p className="hs-empty">{board.reports.length ? 'No reports of this kind.' : 'No reports yet. A session reports when it cannot go on without you, or when a piece of work is complete.'}</p>}
      <ul>
        {reports.map(r => {
          const live = running.has(r.session);
          const body = <>
            <span className={`hs-dot ${r.kind === 'needs_human' ? 'waiting' : 'idle'}${open.has(r.id) ? '' : ' past'}`} aria-label={KIND[r.kind] ?? r.kind}/>
            <span className="hs-item-text">
              <strong>{r.name || r.session}{open.has(r.id) && <em>{r.kind === 'needs_human' ? 'waiting for you' : 'not looked at'}</em>}</strong>
              <span className="hs-board-text">{r.text}</span>
              <small>{KIND[r.kind] ?? r.kind} · <span title={r.cwd}>{folder(r.cwd)}</span> · {formatAge(r.created)}{live ? '' : ' · session ended'}</small>
            </span>
          </>;
          return <li key={r.id} className={open.has(r.id) ? 'open' : ''}>
            {live ? <button type="button" className="hs-board-row" title="Show this session in Live" onClick={() => onOpen(r.session)}>{body}</button> : <div className="hs-board-row">{body}</div>}
          </li>;
        })}
      </ul>
    </section>
    <section aria-label="Bulletin board">
      <header className="hs-board-head">
        <h2>Bulletin board</h2>
        <small>Notes sessions left for each other, until they expire</small>
      </header>
      {board && !notes.length && <p className="hs-empty">No notes. Sessions post here what the others in a folder should know: a file being edited, a step nobody should run.</p>}
      <ul>
        {notes.map(n => <li key={n.id}>
          <div className="hs-board-row">
            <span className="hs-item-text">
              <strong>{n.from.name || 'Supervisor'}</strong>
              <span className="hs-board-text">{n.text}</span>
              <small>
                {n.scope === 'all' ? 'all sessions' : <span title={n.folder}>{folder(n.folder)}</span>} · posted {formatAge(n.posted)} · expires {formatUntil(n.expires)}
                {n.untilItsSessionEnds ? ', or when its session ends' : ''} · read by {n.readBy}
              </small>
            </span>
            <button type="button" className={`hs-board-remove${removing === n.id ? ' sure' : ''}`} aria-label={removing === n.id ? 'Confirm: remove this note' : 'Remove this note'} title="Take this note off the board for every session" onClick={() => remove(n.id)}>
              {removing === n.id ? 'Remove' : <X size={12}/>}
            </button>
          </div>
        </li>)}
      </ul>
    </section>
  </div>;
}
