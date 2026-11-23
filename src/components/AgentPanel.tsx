import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CheckCheck, ChevronDown, ChevronRight, EyeOff, Folder, RefreshCw, Search } from 'lucide-react';
import { Button, PaneFrame } from '@lambda-house/ui';
import clsx from 'clsx';
import { useStore } from '../store';
import {
  disableAgentWorkspace,
  enableAgentWorkspace,
  readFile,
  type AgentEntry,
  type AgentKind,
} from '../utils/tauri';
import {
  AGENT_SECTIONS,
  agentEntryMatches,
  agentFolders,
  formatAge,
  markAgentFilesRead,
  refreshAgentWorkspace,
} from '../utils/agent';
import { shortPath } from '../utils/harness';
import PanelZoomBadge from './PanelZoomBadge';
import { useSmoothWheelScroll } from '@lambda-house/ui';
import { useReader } from '../reader';
import { activeTabOf, focusedGroupOf } from '@lambda-house/reader';

// ============================================================
// Agent documents: instructions, rules, memory, plans and skills of coding
// agents, by the folder their sessions work in
// ============================================================

/** Kinds whose entries show their description (a skill is what it says it does). */
const DESCRIBED: AgentKind[] = ['rule', 'memory', 'skill', 'agent', 'command'];

const AgentItem: React.FC<{ entry: AgentEntry; active: boolean; showGroup?: boolean }> = ({
  entry,
  active,
  showGroup,
}) => {
  const openDocument = useReader((s) => s.openDocument);
  const reloadDocument = useReader((s) => s.reloadDocument);

  // Single click opens the preview tab, double-click a permanent tab
  const open = useCallback(async (preview: boolean) => {
    try {
      const content = await readFile(entry.path);
      reloadDocument(entry.path, content);
      openDocument(entry.path, content, { preview });
    } catch (error) {
      console.error('Failed to open agent file:', error);
    }
  }, [entry.path, openDocument, reloadDocument]);

  const status = entry.isNew ? 'New' : entry.unread ? 'Changed' : null;

  return (
    <div
      className={clsx('agent-item', active && 'selected', entry.unread && 'unread')}
      onClick={() => open(true)}
      onDoubleClick={() => open(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(true);
        }
      }}
      role="treeitem"
      tabIndex={0}
      title={entry.path}
    >
      <div className="agent-item-row">
        <span className="agent-item-dot" aria-hidden="true" />
        <span className="agent-item-title">{entry.title}</span>
        {status && <span className="agent-item-status">{status}</span>}
        <span className="agent-item-age">{formatAge(entry.modified)}</span>
      </div>
      {showGroup && <div className="agent-item-group">{entry.group}</div>}
      {entry.description && DESCRIBED.includes(entry.kind) && (
        <div className="agent-item-description">{entry.description}</div>
      )}
    </div>
  );
};

/** Session folders shown open before the person chooses. */
const OPEN_FOLDERS = 4;

const AgentPanel: React.FC<{ width: number }> = ({ width }) => {
  const entries = useStore((s) => s.agentEntries);
  const sessionFolders = useStore((s) => s.agentFolders);
  const setAgentEntries = useStore((s) => s.setAgentEntries);
  const activePath = useReader((s) => activeTabOf(focusedGroupOf(s))?.path ?? null);
  const zoom = useStore((s) => s.panelZoom.files);
  const smoothScroll = useReader((s) => s.settings.smoothScroll);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ plan: true, command: true });
  const treeRef = useRef<HTMLElement>(null);
  useSmoothWheelScroll(treeRef, smoothScroll, enabled === true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEnabled(await refreshAgentWorkspace());
    } catch (error) {
      console.error('Failed to list agent files:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleEnable = useCallback(async () => {
    try {
      if (await enableAgentWorkspace()) await refresh();
    } catch (error) {
      console.error('Failed to turn on the agent workspace:', error);
    }
  }, [refresh]);

  const handleDisable = useCallback(async () => {
    await disableAgentWorkspace();
    setAgentEntries([], []);
    setEnabled(false);
  }, [setAgentEntries]);

  const visible = useMemo(() => entries.filter((e) => agentEntryMatches(e, query)), [entries, query]);
  const changed = useMemo(() => visible.filter((e) => e.unread && !e.isNew), [visible]);
  const grouped = useMemo(() => agentFolders(visible, sessionFolders), [visible, sessionFolders]);

  const handleMarkAllRead = useCallback(() => {
    markAgentFilesRead(entries.filter((e) => e.unread).map((e) => e.path)).catch((error) => {
      console.error('Failed to save read state:', error);
    });
  }, [entries]);

  const toggleSection = (key: string, open: boolean) => setCollapsed((c) => ({ ...c, [key]: open }));

  const renderSection = (key: string, label: string, items: AgentEntry[], flat = false) => {
    if (items.length === 0) return null;
    // A filter opens every section that has matches
    const isCollapsed = !query && collapsed[key];
    const groups = new Map<string, AgentEntry[]>();
    for (const item of items) {
      const group = flat ? '' : item.group;
      groups.set(group, [...(groups.get(group) ?? []), item]);
    }
    const unread = items.filter((e) => e.unread).length;
    return (
      <section className="agent-section" key={key}>
        <button type="button" className="agent-section-header" aria-expanded={!isCollapsed} onClick={() => toggleSection(key, !isCollapsed)}>
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span className="agent-section-title">{label}</span>
          <span className="agent-section-count">
            {unread > 0 && !flat ? `${unread} new · ` : ''}{items.length}
          </span>
        </button>
        {!isCollapsed && [...groups.entries()].map(([group, groupItems]) => (
          <div className="agent-group" key={group || 'all'}>
            {group && <div className="agent-group-title" title={group}>{group}</div>}
            {groupItems.map((entry) => (
              <AgentItem key={entry.path} entry={entry} active={entry.path === activePath} showGroup={flat} />
            ))}
          </div>
        ))}
      </section>
    );
  };

  // A session folder: its documents by kind, under the kind's name
  const renderFolder = (path: string, items: AgentEntry[], index: number) => {
    const key = `folder:${path}`;
    const isCollapsed = !query && (collapsed[key] ?? index >= OPEN_FOLDERS);
    const unread = items.filter((e) => e.unread).length;
    return (
      <section className="directory-section agent-folder" key={key} aria-label={`Agent documents in ${path}`}>
        <button type="button" className="directory-section-header agent-folder-header" aria-expanded={!isCollapsed} onClick={() => toggleSection(key, !isCollapsed)}>
          <span className={clsx('directory-section-expand', !isCollapsed && 'expanded')}><ChevronRight size={14} /></span>
          <Folder size={14} className="directory-section-icon" />
          <span className="directory-section-path" title={path}>{shortPath(path)}</span>
          <span className="agent-section-count">{unread > 0 ? `${unread} new · ` : ''}{items.length}</span>
        </button>
        {!isCollapsed && AGENT_SECTIONS.map(({ kind, label }) => {
          const ofKind = items.filter((e) => e.kind === kind);
          return ofKind.length === 0 ? null : (
            <div className="agent-group" key={kind}>
              <div className="agent-group-title">{label}</div>
              {ofKind.map((entry) => <AgentItem key={entry.path} entry={entry} active={entry.path === activePath} />)}
            </div>
          );
        })}
      </section>
    );
  };

  return (
    <PaneFrame
      as="aside"
      className="file-panel"
      style={{ width }}
      data-zoom-panel="files"
      title="Agent documents"
      tools={<>
        <PanelZoomBadge panel="files" />
        {enabled && <>
          <Button variant="ghost" size="xs" icon={<CheckCheck size={16} />} onClick={handleMarkAllRead} title="Mark everything as read" aria-label="Mark everything as read" disabled={!entries.some((e) => e.unread)} />
          <Button variant="ghost" size="xs" icon={<RefreshCw size={16} />} onClick={refresh} title="Refresh" aria-label="Refresh" disabled={loading} busy={loading} />
          <Button variant="ghost" size="xs" icon={<EyeOff size={16} />} onClick={handleDisable} title="Stop reading agent documents" aria-label="Stop reading agent documents" />
        </>}
      </>}
    >

      {enabled === null && <p className="agent-panel-empty">Loading agent documents…</p>}
      {enabled === false && (
        <div className="agent-panel-intro">
          <Bot size={32} aria-hidden="true" />
          <p>
            See what your coding agents read and write: <code>CLAUDE.md</code> and <code>AGENTS.md</code>,
            rules, memory, plans, skills and commands, with what changed since you last looked.
          </p>
          <p className="agent-panel-intro-detail">
            Covers the agents' own folders (Claude Code, Codex, Gemini CLI) and the folders your sessions work in.
            Settings, keys and transcripts are never read.
          </p>
          <button type="button" className="agent-panel-enable" onClick={handleEnable}>
            Show agent documents
          </button>
        </div>
      )}

      {enabled && (
        <>
          <div className="agent-panel-filter">
            <Search size={13} className="agent-panel-filter-icon" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter memory, plans, skills…"
              aria-label="Filter agent documents"
            />
          </div>
          <nav ref={treeRef} className="file-tree" role="tree" aria-label="Agent documents">
            <div className="panel-zoom agent-panel-content" style={{ zoom: zoom / 100 }}>
              {renderSection('changed', 'Changed since you read them', changed, true)}
              {grouped.folders.map((f, index) => renderFolder(f.path, f.entries, index))}
              {grouped.user.length > 0 && <div className="agent-user-title">All folders</div>}
              {AGENT_SECTIONS.map(({ kind, label }) =>
                renderSection(kind, label, grouped.user.filter((e) => e.kind === kind)))}
              {visible.length === 0 && (
                <p className="agent-panel-empty">
                  {entries.length === 0 ? 'No agent documents found yet.' : 'Nothing matches the filter.'}
                </p>
              )}
            </div>
          </nav>
        </>
      )}
    </PaneFrame>
  );
};

export default AgentPanel;
