import { homePath } from '../utils/paths';
import { useMemo, useState } from 'react';
import { Filter } from 'lucide-react';
import SessionTree from './SessionTree';
import { type Session } from '../utils/sessions';
import { formatAge } from '../utils/agent';
import { shortPath } from '../utils/harness';

/** Folders listed before the person is asked to narrow the search. */
const MAX_FOLDERS = 40;
/** Folders whose sessions are shown without a click. */
const OPEN_FOLDERS = 4;
const tilde = (path: string) => homePath(path) || 'Unknown folder';

/**
 * Search results by folder, in the same shape as the Live list: the folder's
 * path on the top line, its sessions under it (subagents under their parents).
 */
export default function SessionResults({ all, matches, selected, select, directory, narrow }: {
  all: Session[]; matches: Session[]; selected: string; select: (key: string) => void;
  directory: string; narrow: (directory: string) => void;
}) {
  const folders = useMemo(() => {
    const by = new Map<string, Session[]>();
    for (const s of matches) by.set(s.cwd, [...(by.get(s.cwd) ?? []), s]);
    return [...by.entries()].map(([path, sessions]) => ({ path, sessions, latest: Math.max(...sessions.map(s => s.modified)) })).sort((a, b) => b.latest - a.latest);
  }, [matches]);
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const flip = (path: string) => setToggled(old => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  return <div className="ss-results">
    {folders.slice(0, MAX_FOLDERS).map((f, i) => {
      const open = (i < OPEN_FOLDERS) !== toggled.has(f.path);
      return <section key={f.path} className="ss-dir" aria-label={`Folder ${f.path}`}>
        <header className="hs-dir-head">
          <button type="button" className="ss-dir-toggle" aria-expanded={open} title={f.path} onClick={() => flip(f.path)}><span className="hs-dir-path">{shortPath(tilde(f.path))}</span></button>
          <span className="hs-dir-rule"/>
          <small>{f.sessions.length} · {formatAge(f.latest)}</small>
          {directory !== f.path && f.path && <button type="button" className="hs-dir-start" title="Search only this folder" aria-label={`Search only ${f.path}`} onClick={() => narrow(f.path)}><Filter size={11}/></button>}
        </header>
        {open && <SessionTree all={all} matches={f.sessions} selected={selected} select={select}/>}
      </section>;
    })}
    {folders.length > MAX_FOLDERS && <p className="ss-more">{folders.length - MAX_FOLDERS} more folders: narrow the search to see them.</p>}
  </div>;
}
