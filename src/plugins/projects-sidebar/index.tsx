import { useMemo, useState } from 'react';
import { BellRing, Check, ChevronDown, ChevronRight, Copy, Folder, Pencil, Plus, Radar, Search, SquarePen, X } from 'lucide-react';
import { Button, Kbd } from '../../teob-ui';
import AgentMark from '../../components/AgentMark';
import {
  groupSessions,
  harnessApi,
  hostedState,
  isSupervisor,
  maybeOpenElsewhere,
  STATE_LABEL,
  type Hosted,
  type Resumable,
} from '../../utils/harness';
import { formatAge } from '../../utils/agent';
import { useStore } from '../../store';
import { createPlugin, pluginRegistry, type LiveControllerContext } from '../sdk';

const base = (path: string) => path.split('/').filter(Boolean).pop() || path;
const OVERRIDES_KEY = 'agent-mcr:session-overrides';
interface SessionOverride { title?: string; role?: string }
function loadOverrides(): Record<string, SessionOverride> {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}') as Record<string, SessionOverride>; } catch { return {}; }
}

const ROLE_RULES: ReadonlyArray<[RegExp, string]> = [
  [/\b(ui|ux|css|design|figma|layout|modal|dialog|sidebar|button|style|color|theme|prototype|прототип|дизайн|верстк|окно|панел|интерфейс)\b/i, 'UX/UI Designer'],
  [/\b(test|vitest|jest|playwright|pytest|spec|assert|coverage|тест|провер)\b/i, 'Tester'],
  [/\b(fix|bug|error|fail|crash|debug|broken|issue|trace|ошибк|баг|почин|падает|исправ)\b/i, 'Debugger'],
  [/\b(architect|refactor|migrate|schema|design\s+system|structure|рефактор|архитект|миграц|структур)\b/i, 'Architect'],
  [/\b(research|investigate|explore|compare|analyze|audit|исследуй|изучи|найди|проверь|сравни|аудит)\b/i, 'Researcher'],
  [/\b(rust|cargo|tauri|api|db|sql|server|backend|daemon|endpoint|сервер|бэкенд|база)\b/i, 'Backend'],
];

const inferRole = (raw: string) => ROLE_RULES.find(([re]) => re.test(raw))?.[1] ?? 'All-around Agent';

function ProjectsSidebar({ controller }: { controller: LiveControllerContext }) {
  const s = controller.sidebarState;
  const openedFolders = useStore(st => st.directories);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, SessionOverride>>(loadOverrides);
  const [editingSession, setEditingSession] = useState<{ id: string; role: string; title: string } | null>(null);

  const hosted = controller.hosted;
  const resumable = s?.resumable ?? [];
  const titles = s?.titles ?? {};
  const status = s?.status ?? null;

  const needsYou = (h: Hosted) => !h.exit && !!h.harness?.attention;
  const waiting = useMemo(() => hosted.filter(h => !h.exit && h.harness?.attention), [hosted]);
  const sorted = useMemo(
    () => hosted.filter(h => h.exit || !isSupervisor(h)).sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || Number(!!a.exit) - Number(!!b.exit) || b.started - a.started),
    [hosted],
  );
  const running = hosted.filter(h => !h.exit).length;
  const supervisor = hosted.find(h => !h.exit && isSupervisor(h));
  const groups = useMemo(() => groupSessions(sorted), [sorted]);

  const suggestions = useMemo(
    () => [...new Set([status?.home ?? '', ...openedFolders].filter(Boolean))].slice(0, 40),
    [status, openedFolders],
  );

  const projectFolders = useMemo(() => {
    const byCwd = new Map<string, Resumable[]>();
    for (const r of resumable) {
      const list = byCwd.get(r.cwd) ?? [];
      list.push(r);
      byCwd.set(r.cwd, list);
    }
    const withSessions = [...byCwd.entries()].sort((a, b) => (b[1][0]?.modified ?? 0) - (a[1][0]?.modified ?? 0));
    const seen = new Set(withSessions.map(([d]) => d));
    const extra = suggestions.filter(d => !seen.has(d)).map((d): [string, Resumable[]] => [d, []]);
    return [...withSessions, ...extra];
  }, [resumable, suggestions]);

  const saveOverride = (id: string, next: SessionOverride) => {
    setOverrides(prev => {
      const updated = { ...prev };
      const title = next.title?.trim() || undefined;
      const role = next.role?.trim() || undefined;
      if (!title && !role) delete updated[id];
      else updated[id] = { title, role };
      try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
      return updated;
    });
    setEditingSession(null);
  };

  const resolveSessionIdentity = (r: Resumable) => {
    const ov = overrides[r.id];
    const harnessName = r.agent === 'claude' ? 'Claude Code' : 'Codex';
    const raw = (titles[r.id] || r.title || '').replace(/\s+/g, ' ').trim();
    const role = ov?.role || r.role || inferRole(raw);
    const task = ov?.title || raw;
    return { harnessName, role, task, raw };
  };

  if (!s) return null;

  return (
    <aside className="hs-list" aria-label="Hosted sessions">
      <div className="hs-side-head">
        <div className="hs-brand">
          <span className="hs-brand-mark" aria-hidden="true">M</span>
          <span className="hs-brand-name">Agent MCR</span>
        </div>
        {running > 0 && <span className="hs-running-pill">{running} live</span>}
      </div>
      {pluginRegistry.isEnabled('command-panel') && (
        <button
          type="button"
          className="hs-search hs-search--trigger"
          aria-label="Search sessions"
          aria-keyshortcuts="Meta+K"
          onClick={() => pluginRegistry.emitEvent('command-panel:open', {})}
        >
          <Search size={14} className="hs-search-icon" aria-hidden="true"/>
          <span className="hs-search-placeholder">Search sessions…</span>
          <Kbd>⌘K</Kbd>
        </button>
      )}
      <div className="hs-side-utils">
        <button type="button" className="hs-new-agent-btn" disabled={!status} onClick={() => controller.openNewAgent()}>
          <SquarePen size={15}/>
          <span>New agent</span>
        </button>
        <div className={`hs-supervisor${supervisor ? ' running' : ''}${supervisor && supervisor.id === controller.selected ? ' selected' : ''}${supervisor && needsYou(supervisor) ? ' needs-you' : ''}`}>
          <button
            type="button"
            className="hs-supervisor-open"
            disabled={!status || s.starting}
            onClick={() => void s.openSupervisor()}
            title="A Claude session wired to this harness: it sees and directs all the other sessions. It cannot answer their permission prompts; only you can."
          >
            <Radar size={15}/>
            <span className="hs-item-text">
              <strong>{supervisor ? 'Supervisor' : 'Open supervisor'}{supervisor && <span className={`hs-dot ${hostedState(supervisor)}`} aria-label={STATE_LABEL[hostedState(supervisor)]}/>}</strong>
              {supervisor && needsYou(supervisor) && <small className="hs-needs">{supervisor.harness?.attention?.text}</small>}
              {supervisor?.harness?.status && <small className="hs-status">{supervisor.harness.status}</small>}
            </span>
          </button>
          {supervisor && s.renderSupervisorMenu(supervisor)}
        </div>
      </div>
      {waiting.length > 0 && <p className="hs-attention" role="status"><BellRing size={12}/> {waiting.length === 1 ? '1 session is waiting for you' : `${waiting.length} sessions are waiting for you`}</p>}
      {s.error && <div className="hs-error" role="alert">{s.error}</div>}
      <div className="hs-section-label">Sessions</div>
      <ul>
        {groups.map(group => group.length === 1 ? s.renderSessionRow(group[0])
          : <li key={`group-${group[0].id}`} className="hs-group" title="These sessions run in the same folder or exchanged messages in the last day">
            <ul aria-label="Sessions working together">{group.map(s.renderSessionRow)}</ul>
          </li>)}
      </ul>
      {!hosted.length && status && <p className="hs-empty">No live sessions. Click New agent above to start one.</p>}
      {projectFolders.length > 0 && <>
        <div className="hs-section-label">Projects</div>
        <div className="hs-projects" aria-label="Past sessions by project">
          {projectFolders.map(([dir, sessions]) => {
            const isOpen = !!expandedProjects[dir];
            return (
              <div key={dir} className="hs-project">
                <div className="hs-project-row">
                  <button type="button" className="hs-project-toggle" aria-expanded={isOpen} onClick={() => setExpandedProjects(p => ({ ...p, [dir]: !isOpen }))} title={dir}>
                    {isOpen ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
                    <Folder size={14} className="hs-project-icon"/>
                    <span className="hs-project-name">{base(dir)}</span>
                    <span className="hs-project-count">{sessions.length}</span>
                  </button>
                  <button type="button" className="hs-project-add" title={`New agent in ${base(dir)}`} aria-label={`New agent in ${base(dir)}`} onClick={() => s.openNewAgentInDir(dir)}><Plus size={13}/></button>
                </div>
                {isOpen && <div className="hs-project-list">
                  {sessions.map(r => {
                    const idn = resolveSessionIdentity(r);
                    const isEditing = editingSession?.id === r.id;
                    if (isEditing && editingSession) {
                      return (
                        <form key={r.id} className="hs-past-edit" onSubmit={e => { e.preventDefault(); saveOverride(r.id, { role: editingSession.role, title: editingSession.title }); }}>
                          <input type="text" value={editingSession.role} onChange={e => setEditingSession({ ...editingSession, role: e.target.value })} placeholder="Role badge (e.g. UX/UI Designer)" aria-label="Session role"/>
                          <input type="text" value={editingSession.title} onChange={e => setEditingSession({ ...editingSession, title: e.target.value })} placeholder="Session title" aria-label="Session title"/>
                          <div className="hs-past-edit-actions">
                            <button type="submit" aria-label="Save"><Check size={12}/></button>
                            <button type="button" aria-label="Cancel" onClick={() => setEditingSession(null)}><X size={12}/></button>
                          </div>
                        </form>
                      );
                    }
                    return (
                      <div key={r.id} className="hs-past-row">
                        <button type="button" className="hs-past-item" disabled={s.starting} onClick={() => void s.startSession(undefined, r.cwd, r.id)} title={`${idn.role}${idn.raw ? ` — ${idn.raw}` : ''}\n${r.cwd}`}>
                          <AgentMark profile={r.agent} size={13}/>
                          <span className="hs-past-text">
                            {idn.task && <span className="hs-past-title">{idn.task}</span>}
                            <span className="hs-past-meta">
                              <span className="hs-role-pill hs-role-pill--sm">{idn.role}</span>
                              <span>{idn.harnessName} · {formatAge(r.modified)}</span>
                            </span>
                          </span>
                          {maybeOpenElsewhere(r, Date.now()) && <span className="hs-past-warn" title="Modified recently — may be open elsewhere">open?</span>}
                        </button>
                        <button type="button" className="hs-past-edit-btn" title="Rename or change role" aria-label="Rename or change role" onClick={() => setEditingSession({ id: r.id, role: overrides[r.id]?.role ?? idn.role, title: overrides[r.id]?.title ?? idn.raw })}>
                          <Pencil size={11}/>
                        </button>
                      </div>
                    );
                  })}
                </div>}
              </div>
            );
          })}
        </div>
      </>}
      {pluginRegistry.getSidebarSections().map(section => (
        <div key={section.id} className="hs-plugin-sidebar-section">
          {section.render(controller)}
        </div>
      ))}
      <footer className="hs-footer">
        <span>{status ? `Runner pid ${status.runner.pid} · ${running} running` : 'Connecting to the runner…'}</span>
        {status?.supervisorCommand && <Button variant="ghost" size="sm" title={`Copy the command that gives an outside Claude Code the supervisor tools:\n${status.supervisorCommand}`} aria-label="Copy supervisor setup command" onClick={() => { void navigator.clipboard.writeText(status.supervisorCommand ?? '').then(() => { s.setCopied(true); setTimeout(() => s.setCopied(false), 1500); }).catch(e => s.setError(e instanceof Error ? e.message : String(e))); }}><Copy size={12}/> {s.copied ? 'Copied' : 'Supervisor'}</Button>}
        {status && <label className="hs-outside" title="Off: only the Supervisor session here has the supervisor tools. On: an agent you run outside Agent MCR and connected with the supervisor command has them too."><input type="checkbox" checked={!!status.outsideSupervisors} onChange={e => { void harnessApi.outsideSupervisors(e.target.checked).then(on => s.setStatus(prev => prev && { ...prev, outsideSupervisors: on })).catch(x => s.setError(x instanceof Error ? x.message : String(x))); }}/> outside agents</label>}
      </footer>
    </aside>
  );
}

export const plugin = createPlugin({
  id: 'projects-sidebar',
  name: 'Projects Sidebar',
  version: '1.0.0',
  description: 'Replaces the folder-grouped Live sidebar with a flat Sessions list and collapsible Projects view.',
  defaultDisabled: true,
  setup(api) {
    api.overrideComponent('live:sidebar', ({ controller }) => (
      <ProjectsSidebar controller={controller} />
    ));
  },
});
