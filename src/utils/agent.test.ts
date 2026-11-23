// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { agentEntryMatches, agentFolders } from './agent';
import type { AgentEntry } from './tauri';

describe('agent list helpers', () => {
  const entry: AgentEntry = {
    path: '/repo/.cursor/rules/api.mdc',
    kind: 'rule',
    title: 'api',
    description: 'Applies to src/api/**',
    group: '~/repo',
    scope: 'project',
    folder: '/repo',
    modified: 0,
    unread: false,
    isNew: false,
  };

  it('filters on title, description, group and path', () => {
    expect(agentEntryMatches(entry, '')).toBe(true);
    expect(agentEntryMatches(entry, 'API')).toBe(true);
    expect(agentEntryMatches(entry, 'src/api')).toBe(true);
    expect(agentEntryMatches(entry, '.cursor')).toBe(true);
    expect(agentEntryMatches(entry, 'memory')).toBe(false);
  });

  it('groups documents by the nearest session folder', () => {
    const inRepo = { ...entry };
    const memoryOfSub = { ...entry, path: '/home/.claude/projects/-repo-app/memory/MEMORY.md', kind: 'memory' as const, scope: 'user' as const, folder: '/repo/app' };
    const memoryElsewhere = { ...memoryOfSub, path: '/home/.claude/projects/-other/memory/a.md', folder: '/other' };
    const own = { ...entry, path: '/home/.claude/CLAUDE.md', scope: 'user' as const, folder: null };
    const nested = { ...entry, path: '/repo/sub/CLAUDE.md', folder: '/repo/sub' };
    const grouped = agentFolders([inRepo, memoryOfSub, memoryElsewhere, own, nested], ['/repo/sub', '/repo', '/empty']);
    expect(grouped.folders.map((f) => [f.path, f.entries.map((e) => e.path)])).toEqual([
      ['/repo/sub', ['/repo/sub/CLAUDE.md']],
      ['/repo', ['/repo/.cursor/rules/api.mdc', '/home/.claude/projects/-repo-app/memory/MEMORY.md']],
    ]);
    expect(grouped.user).toEqual([memoryElsewhere, own]);
    // A folder whose name only starts the same is another folder
    expect(agentFolders([{ ...entry, folder: '/repository' }], ['/repo']).user).toHaveLength(1);
  });
});
