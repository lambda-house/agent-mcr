import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, RotateCw, ShieldAlert } from 'lucide-react';
import { aheadBehind, changesApi, counts, diffLines, fileKey, findFile, pickFile, sideTotals, stagedLabel, type ChangedFile, type Changes, type ChangeSide, type Which } from '../utils/changes';
import { keepSame } from '@lambda-house/ui';
import type { Hosted } from '../utils/harness';

const NONE: string[] = [];
const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * What the selected session changed in its git work tree (MCR-176): branch
 * and head, commits ahead of and behind the base, uncommitted and committed
 * files with a diff each. Read only: no button here stages, commits,
 * discards, pushes or fetches.
 *
 * Nothing polls (MCR-139): it reads when it is shown for a session, when the
 * window comes back to the front and when Refresh is pressed, and an answer
 * that says the same renders nothing. It is mounted only for the focused
 * pane while its side pane is open.
 */
export default function ChangesPane({ session, active }: { session: Hosted; active: boolean }) {
  const [data, setData] = useState<Changes | null>(null);
  const [error, setError] = useState('');
  // Only a press of Refresh shows that a read is under way: a read on focus
  // that brings the same answer changes no state, so nothing renders
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  const showBusy = (on: boolean) => { if (busyNow.current !== on) { busyNow.current = on; setBusy(on); } };
  const readAt = useRef(0);
  const [chosen, setChosen] = useState('');
  const request = useRef(0);
  const shown = useRef<{ data: Changes | null; error: string }>({ data: null, error: '' });
  const id = session.id;

  const load = useCallback((pressed = false) => {
    const mine = ++request.current;
    if (pressed) showBusy(true);
    changesApi.read(id)
      .then(c => {
        if (request.current !== mine) return;
        readAt.current = Date.now();
        // Set only what changed: two updates queued together render even when both say the same
        const next = keepSame(shown.current.data, c);
        if (next !== shown.current.data) { shown.current.data = next; setData(next); }
        if (shown.current.error) { shown.current.error = ''; setError(''); }
      })
      .catch(e => { if (request.current === mine) { shown.current.error = err(e); setError(shown.current.error); } })
      // The newest read ends the wait, whichever started it: a read on focus may take over a pressed one
      .finally(() => { if (request.current === mine) showBusy(false); });
  }, [id]);

  useEffect(() => {
    shown.current = { data: null, error: '' };
    setData(null); setError(''); setChosen(''); showBusy(false);
    if (!active) return;
    load();
    const again = () => { if (!document.hidden) load(); };
    window.addEventListener('focus', again);
    return () => { window.removeEventListener('focus', again); request.current++; };
  }, [active, load]);

  const repo = data?.repo ?? null;
  const selected = repo ? pickFile(repo, chosen) : '';
  const file = repo && selected ? findFile(repo, selected) : null;

  const head = <header className="hs-changes-head">
    <GitBranch size={13} aria-hidden/>
    {repo ? <>
      <strong title={repo.root}>{repo.branch ?? 'detached head'}</strong>
      {repo.head && <code className="hs-changes-sha" title={repo.head}>{repo.head.slice(0, 12)}</code>}
    </> : <strong>Changes</strong>}
    <button type="button" className="hs-changes-refresh" onClick={() => load(true)} disabled={busy} title={readAt.current ? `Read at ${time(readAt.current)}. Read the work tree again (nothing is fetched)` : 'Read the work tree again (nothing is fetched)'} aria-label="Refresh changes">
      <RotateCw size={12}/>
    </button>
  </header>;

  const body = () => {
    if (error) return <p className="hs-stats-note hs-changes-error">{error}</p>;
    if (!data) return <p className="hs-stats-note">Reading the work tree…</p>;
    if (!repo) return <p className="hs-stats-note">{data.note ?? 'No git work tree here.'}</p>;
    return <>
      <section className="hs-changes-tracks">
        {repo.base
          ? <p><span className="hs-changes-label">Base</span> {repo.base.name}: {aheadBehind(repo.base)}</p>
          : <p className="hs-stats-note">{repo.baseNote}</p>}
        {repo.upstream && <p title="The branch's upstream, as of the last fetch: nothing is fetched here"><span className="hs-changes-label">Upstream</span> {repo.upstream.name}: {aheadBehind(repo.upstream)}</p>}
        {repo.hidden > 0 && <p className="hs-changes-hidden"><ShieldAlert size={12} aria-hidden/> {repo.hidden === 1 ? 'One line is' : `${repo.hidden} lines are`} hidden: they have the shape of a credential. Read them in a terminal of your own.</p>}
      </section>
      {repo.base && <section>
        <h4>Commits ahead of {repo.base.name} · {repo.base.ahead}</h4>
        {repo.commits.length === 0 ? <p className="hs-stats-note">{repo.commitsMore ? 'Too many to list here.' : 'None.'}</p> : <ul className="hs-changes-commits">
          {repo.commits.map(c => <li key={c.sha} title={`${c.sha}\n${c.author}, ${new Date(c.time * 1000).toLocaleString()}`}>
            <code>{c.short}</code><span>{c.subject}</span>
          </li>)}
          {repo.commitsMore && <li className="hs-stats-more">More not shown.</li>}
        </ul>}
      </section>}
      <FileList title="Uncommitted" which="uncommitted" side={repo.uncommitted} shown={selected} choose={setChosen} untracked={repo.untracked} untrackedMore={repo.untrackedMore}/>
      {repo.base && <FileList title={`Committed since ${repo.base.name}`} which="committed" side={repo.committed} shown={selected} choose={setChosen}/>}
      {file && <FileDiff file={file} which={selected.startsWith('uncommitted:') ? 'uncommitted' : 'committed'}/>}
    </>;
  };

  return <aside className="hs-stats hs-changes" aria-label="Session changes">{head}{body()}</aside>;
}

const FileList = memo(function FileList({ title, which, side, shown, choose, untracked = NONE, untrackedMore = false }: {
  title: string; which: Which; side: ChangeSide; shown: string; choose: (key: string) => void; untracked?: string[]; untrackedMore?: boolean;
}) {
  const totals = sideTotals(side);
  return <section>
    <h4>{title} · {totals.files}{totals.files ? ` · +${totals.added} −${totals.removed}` : ''}</h4>
    {side.note && <p className="hs-stats-note">{side.note}</p>}
    {side.files.length === 0 && untracked.length === 0 && !side.note && !side.more && !untrackedMore && <p className="hs-stats-note">Nothing.</p>}
    {side.files.length === 0 && side.more && <p className="hs-stats-note hs-changes-more">More files than can be listed here.</p>}
    {side.files.length > 0 && <ul className="hs-changes-files">
      {side.files.map(f => {
        const key = fileKey(which, f.path);
        return <li key={key}>
          <button type="button" aria-pressed={key === shown} onClick={() => choose(key)} title={which === 'uncommitted' ? `${f.path}\n${stagedLabel(f)}` : f.path}>
            <span className={`hs-changes-status s-${f.status}`}>{f.status}</span>
            <span className="hs-stats-name">{f.path}</span>
            <span className="hs-changes-counts">{counts(f)}</span>
          </button>
        </li>;
      })}
      {side.more && <li className="hs-stats-more">More files not shown.</li>}
    </ul>}
    {(untracked.length > 0 || untrackedMore) && <p className="hs-stats-note hs-changes-untracked" title="New files git does not track yet: their content is not shown">
      {untracked.length > 0 ? <>Untracked: {untracked.join(', ')}{untrackedMore ? ', and more' : ''}</> : 'Untracked: more names than can be listed here.'}
    </p>}
  </section>;
});

const FileDiff = memo(function FileDiff({ file, which }: { file: ChangedFile; which: Which }) {
  const lines = useMemo(() => file.diff ? diffLines(file.diff) : [], [file.diff]);
  return <section className="hs-changes-diff" aria-label={`Diff of ${file.path}`}>
    <h4 title={file.path}>{file.path} · {counts(file)}{which === 'uncommitted' ? ` · ${stagedLabel(file)}` : ''}</h4>
    {file.undone && <p className="hs-stats-note">Staged, then undone in the work tree: the head and the work tree agree, but a commit would still take the staged change.</p>}
    {file.hidden > 0 && <p className="hs-changes-hidden"><ShieldAlert size={12} aria-hidden/> {file.hidden === 1 ? 'One line' : `${file.hidden} lines`} hidden here.</p>}
    {file.diff
      ? <pre className="hs-diff">{lines.map((l, i) => <span key={i} className={`hs-diff-${l.kind}`}>{l.text}{'\n'}</span>)}</pre>
      : <p className="hs-stats-note">{file.diffNote ?? 'No diff.'}</p>}
  </section>;
});
