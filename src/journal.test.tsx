// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { JournalProvider, JournalView, createJournalStore, type Session } from '@lambda-house/journal';
import { journalHost } from './journal';

// The journal against Agent MCR's own host: what it asks the backend for, and
// what it never offers (no outside service: no remote context, no control).

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./utils/tauri', () => ({ isTauri: () => true }));

const session: Session = { id: 'a', provider: 'claude', parentId: null, name: 'root', cwd: '/work/demo', title: 'Fix CORE-123', model: 'model-a', effort: 'high', started: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', modified: Date.now(), status: 'idle', usage: { input: 100, cached: 70, cacheWrite: 0, output: 20, reasoning: 5 }, usageKnown: true, models: {}, tools: { shell: 2 }, tickets: ['CORE-123'], memoryRefs: [], events: [{ seq: 1, at: '2026-01-01T00:00:00Z', kind: 'assistant', text: 'Done', tool: null }], eventCount: 1, malformedLines: 0, source: '/fake/session.jsonl', turnId: 'turn' };

const backend: Record<string, (args?: Record<string, unknown>) => unknown> = {
  session_access: () => true,
  sessions_snapshot_since: (args) => ({
    stamp: 's1',
    snapshot: args?.stamp === 's1' ? null : { sessions: [{ ...session, events: [] }], scannedFiles: 1, pendingFiles: 0, indexedAt: Date.now(), errors: [] },
  }),
  session_details: () => session,
};

let root: Root; let container: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const answer = backend[command];
    if (!answer) throw new Error(`unexpected command ${command}`);
    return answer(args as Record<string, unknown>);
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('the journal in Agent MCR', () => {
  it('asks the backend for access, the index and the chosen session, and offers no outside service', async () => {
    const store = createJournalStore({ storage: null, name: 'test' });
    await act(async () => root.render(<JournalProvider journal={{ store, host: journalHost }}><JournalView /></JournalProvider>));
    await flush();
    expect(invoke).toHaveBeenCalledWith('session_access');
    // The snapshot with a stamp: the first time none is held
    expect(invoke).toHaveBeenCalledWith('sessions_snapshot_since', { stamp: null });
    expect(invoke).toHaveBeenCalledWith('session_details', { provider: 'claude', id: 'a' });
    expect(container.querySelector('.sc-detail h2')?.textContent).toBe('Fix CORE-123');
    expect(journalHost.context).toBeUndefined();
    expect(journalHost.control).toBeUndefined();
    expect(journalHost.connections).toBeUndefined();
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).not.toContain('Direct');
    expect(labels).not.toContain('Connections');
  });

  it('names the backend commands of memories and agent access', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const s = { provider: 'claude', id: 's' } as Session;
    await journalHost.memories(s);
    expect(invoke).toHaveBeenLastCalledWith('session_memories', { provider: 'claude', id: 's' });
    await journalHost.openMemoryWindow('/m/MEMORY.md', s);
    expect(invoke).toHaveBeenLastCalledWith('open_session_memory_window', { key: '/m/MEMORY.md', provider: 'claude', id: 's' });
    await journalHost.events('claude', 'a', 40);
    expect(invoke).toHaveBeenLastCalledWith('session_events', { provider: 'claude', id: 'a', before: 40 });
    await journalHost.analysis!.revoke();
    expect(invoke).toHaveBeenLastCalledWith('revoke_analysis');
    await journalHost.analysis!.query('analyze_skills', { cohort: {} });
    expect(invoke).toHaveBeenLastCalledWith('run_session_analysis', { name: 'analyze_skills', arguments: { cohort: {} } });
  });
});
