import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ClipboardList, StickyNote, X } from 'lucide-react';
import { create } from 'zustand';
import { Pane, usePane, useSurfaceShown, type PaneType } from '@lambda-house/workbench';
import { Button, Segmented, keepSame } from '@lambda-house/ui';
import { formatUntil, harnessApi, openReports, reportGroups, shortPath, tildePath, type Board, type ExecutorLine, type Hosted, type Report } from '../utils/harness';
import { isTauri } from '../utils/tauri';
import { formatAge } from '../utils/agent';
import { sharedPoll } from '../utils/sharedPoll';
import { useSessionsView } from '../sessionsView';
import '../styles/harness.css';

// Board: what sessions reported to the person (their `report` tool), and the
// notes they left for each other on the bulletin board, as two panes of
// Sessions' layouts (Reports, Bulletin board). Text here is written by
// agents: it is shown, never acted on. Both panes show one board, read every
// few seconds while one of them is on screen.

const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const KIND = { needs_human: 'Needs you', done: 'Done', status: 'Status' } as const;
type Filter = 'all' | keyof typeof KIND;
/** How long a note of the person can stay: label and hours */
const LASTS: [string, number][] = [['1 hour', 1], ['8 hours', 8], ['1 day', 24], ['3 days', 72], ['1 week', 168], ['2 weeks', 336]];
/** The smallest Board or Slack pane, px. */
export const PANEL_MIN = { w: 260, h: 120 };

interface BoardFeed {
  board: Board | null;
  hosted: Hosted[];
  home: string;
  error: string;
}

/** The board, the hosted sessions (which reports can open one) and the home folder (folder names). */
export const useBoard = create<BoardFeed>(() => ({ board: null, hosted: [], home: '', error: '' }));
let homeAsked = false;

export async function refreshBoard(): Promise<void> {
  if (!homeAsked) {
    homeAsked = true;
    harnessApi.status().then(s => useBoard.setState({ home: s.home ?? '' })).catch(() => { homeAsked = false; });
  }
  try {
    const [b, list] = await Promise.all([harnessApi.board(), harnessApi.list()]);
    useBoard.setState(held => ({ board: keepSame(held.board, b), hosted: keepSame(held.hosted, list), error: '' }));
  } catch (e) { useBoard.setState({ error: err(e) }); }
}

const useBoardPoll = sharedPoll(refreshBoard, 3000);

/** The board while this pane is on screen. */
function useBoardFeed(): BoardFeed {
  const pane = usePane();
  const shown = useSurfaceShown() && (pane?.visible ?? true);
  useEffect(() => { if (!isTauri()) useBoard.setState({ error: 'Open the desktop app to see the board.' }); }, []);
  useBoardPoll(shown && isTauri());
  return useBoard();
}

const folderName = (home: string) => (path: string) => shortPath(tildePath(path, home));

/**
 * The executors of a supervising session, as the harness recorded them when
 * the status report was made: not what the agent wrote, and not their state now.
 */
function ExecutorLines({ lines }: { lines: ExecutorLine[] }) {
  return <span className="hs-board-execs" role="list" aria-label="Its executors when it reported">
    {lines.map(e => <span key={e.session} role="listitem">
      <span className={`hs-dot ${e.needsOperator ? 'waiting' : ['working', 'idle', 'starting'].includes(e.state) ? e.state : ''}`} aria-hidden="true"/>
      <span><b>{e.name || e.session}</b> {e.needsOperator ? 'needed you' : e.state}{e.waits.length ? ` · waited for: ${e.waits.join('; ')}` : ''}</span>
    </span>)}
  </span>;
}

/** Reports, grouped by supervisor, with its executors' reports under its own. A click shows the session in Live. */
export function ReportsPanel() {
  const { board, hosted, home, error } = useBoardFeed();
  const [filter, setFilter] = useState<Filter>('all');
  const onOpen = useSessionsView.getState().openLive;
  const running = useMemo(() => new Set(hosted.filter(h => !h.exit).map(h => h.id)), [hosted]);
  const open = useMemo(() => openReports(board?.reports ?? [], hosted), [board, hosted]);
  const groups = useMemo(() => reportGroups((board?.reports ?? []).filter(r => filter === 'all' || r.kind === filter), hosted), [board, filter, hosted]);
  const folder = folderName(home);

  const row = (r: Report) => {
    const live = running.has(r.session);
    const body = <>
      <span className={`hs-dot ${r.kind === 'needs_human' ? 'waiting' : r.kind === 'status' ? 'status' : 'idle'}${open.has(r.id) || r.kind === 'status' ? '' : ' past'}`} aria-label={KIND[r.kind] ?? r.kind}/>
      <span className="hs-item-text">
        <strong>{r.name || r.session}{open.has(r.id) && <em>{r.kind === 'needs_human' ? 'waiting for you' : 'not looked at'}</em>}</strong>
        <span className="hs-board-text">{r.text}</span>
        {!!r.executors?.length && <ExecutorLines lines={r.executors}/>}
        <small>{KIND[r.kind] ?? r.kind} · <span title={r.cwd}>{folder(r.cwd)}</span> · {formatAge(r.created)}{live ? '' : ' · session ended'}</small>
      </span>
      {live && <span className="hs-board-go">{r.kind === 'needs_human' && open.has(r.id) ? 'Answer' : 'Open'}<ArrowRight size={11}/></span>}
    </>;
    return live ? <button type="button" className="hs-board-row" title="Show this session in Live" onClick={() => onOpen(r.session)}>{body}</button> : <div className="hs-board-row">{body}</div>;
  };

  return <Pane as="section" className="hs-board" aria-label="Reports" title="Reports">
    <div className="hs-panel-body">
      <header className="hs-board-head">
        <small>What sessions told you. Click one to open its session</small>
        <Segmented kind="choice" className="hs-board-filter" label="Kind of report" value={filter} onChange={setFilter}
          options={(['all', 'needs_human', 'done', 'status'] as Filter[]).map(f => ({ value: f, label: f === 'all' ? 'All' : KIND[f] }))}/>
      </header>
      {error && <div className="hs-error" role="alert">{error}</div>}
      <p className="hs-board-help">A <b>Needs you</b> report waits until you type into its session; a <b>Done</b> one until you open the session. A <b>Status</b> report notifies nobody: it says where a session and its executors stood, and the session's next one replaces it.</p>
      {board && !groups.length && <p className="hs-empty">{board.reports.length ? 'No reports of this kind.' : 'No reports yet. A session reports when it cannot go on without you, when a piece of work is complete, or to say where it stands.'}</p>}
      {groups.map(g => <div key={g.session || 'alone'} className="hs-board-group" role="group" aria-label={g.session ? `Reports of ${g.name} and its executors` : 'Reports of sessions without a supervisor'}>
        {(g.session || groups.length > 1) && <h3 className="hs-board-group-head">
          {g.session ? <><strong>{g.name}</strong><small>and its executors{g.live ? '' : ' · session ended'}</small></> : <small>Sessions without a supervisor</small>}
          {g.session && g.live && <Button variant="ghost" size="xs" className="hs-board-open" title="Show this session in Live" onClick={() => onOpen(g.session)}>Open<ArrowRight size={11}/></Button>}
        </h3>}
        <ul className="hs-board-reports">
          {g.rows.map(({ report: r, depth }) => <li key={r.id} className={`${open.has(r.id) ? 'open' : ''}${r.kind === 'status' ? ' status' : ''}`.trim()} style={depth ? { paddingLeft: depth * 16 } : undefined}>
            {row(r)}
          </li>)}
        </ul>
      </div>)}
    </div>
  </Pane>;
}

/** The bulletin board: notes sessions read when they start, and the person's own; a note is removed on the second click. */
export function NotesPanel() {
  const { board, hosted, home, error } = useBoardFeed();
  const [removing, setRemoving] = useState('');
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState('');
  const [hours, setHours] = useState(24);
  const [posting, setPosting] = useState(false);
  const notes = useMemo(() => [...board?.notes ?? []].reverse(), [board]);
  const folder = folderName(home);
  // A note can be for one of the folders sessions run in, or for all
  const folders = useMemo(() => [...new Set(hosted.filter(h => !h.exit && h.cwd).map(h => h.cwd))].sort(), [hosted]);
  const post = () => {
    if (!draft.trim() || posting) return;
    setPosting(true);
    harnessApi.postNote(draft, hours, folders.includes(scope) ? scope : undefined)
      .then(() => { setDraft(''); return refreshBoard(); })
      .catch(e => useBoard.setState({ error: err(e) }))
      .finally(() => setPosting(false));
  };
  const remove = (id: string) => {
    if (removing !== id) { setRemoving(id); setTimeout(() => setRemoving(r => r === id ? '' : r), 3000); return; }
    setRemoving('');
    harnessApi.removeNote(id).then(refreshBoard).catch(e => useBoard.setState({ error: err(e) }));
  };

  return <Pane as="section" className="hs-board" aria-label="Bulletin board" title="Bulletin board">
    <div className="hs-panel-body">
      <header className="hs-board-head">
        <small>Notes sessions read when they start, until the notes expire</small>
      </header>
      {error && <div className="hs-error" role="alert">{error}</div>}
      <form className="hs-board-post" aria-label="Leave a note" onSubmit={e => { e.preventDefault(); post(); }}>
        <textarea value={draft} rows={2} maxLength={2000} aria-label="Note" placeholder="Leave a note for the sessions: a rule, a file not to touch, a step nobody should run"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } }}/>
        <div>
          <select value={folders.includes(scope) ? scope : ''} aria-label="Who reads it" onChange={e => setScope(e.target.value)}>
            <option value="">All sessions</option>
            {folders.map(f => <option key={f} value={f}>{folder(f)}</option>)}
          </select>
          <select value={hours} aria-label="How long it stays" onChange={e => setHours(Number(e.target.value))}>
            {LASTS.map(([label, h]) => <option key={h} value={h}>for {label}</option>)}
          </select>
          <Button type="submit" variant="primary" size="xs" className="hs-board-post-go" disabled={!draft.trim() || posting}>Post</Button>
        </div>
      </form>
      {board && !notes.length && <p className="hs-empty">No notes. Sessions, and you, post here what the others in a folder should know: a file being edited, a step nobody should run.</p>}
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
    </div>
  </Pane>;
}

/** Board's panes: in every layout of Sessions, offered in the type menus and the empty pane. */
export const boardPanes: PaneType[] = [
  { type: 'board-reports', label: 'reports', title: 'Reports', icon: <ClipboardList size={14}/>, switchable: true, singleton: true, min: PANEL_MIN, render: () => <ReportsPanel/> },
  { type: 'board-notes', label: 'bulletin board', title: 'Bulletin board', icon: <StickyNote size={14}/>, switchable: true, singleton: true, min: PANEL_MIN, render: () => <NotesPanel/> },
];
