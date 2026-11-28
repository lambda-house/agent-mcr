import { invoke } from '@tauri-apps/api/core';

/**
 * The Changes pane of a hosted session (MCR-176): what `changes::read` in
 * Rust found in the session's work tree. The page names the session only;
 * Rust takes the folder from the runner's record. Read only.
 */
export interface ChangedFile {
  path: string;
  /** Git's letter: M, A, D, T (type), U (unmerged) */
  status: string;
  /** Uncommitted only: in the index / in the work tree */
  staged: boolean;
  unstaged: boolean;
  /** null for a binary file */
  added: number | null;
  removed: number | null;
  binary: boolean;
  diff: string | null;
  /** Why there is no diff: binary, too large, not loaded */
  diffNote: string | null;
  /** Lines hidden as credential shapes */
  hidden: number;
  /** Uncommitted only: listed by git status, not by the net diff from the head, with staged and work tree diffs */
  undone: boolean;
}
export interface ChangeSide { files: ChangedFile[]; more: boolean; note: string | null }
export interface Track { name: string; ahead: number; behind: number; mergeBase: string | null }
export interface Commit { sha: string; short: string; subject: string; author: string; time: number }
export interface Repo {
  root: string;
  /** null: a detached head */
  branch: string | null;
  /** null: no commit yet */
  head: string | null;
  base: Track | null;
  baseNote: string | null;
  upstream: Track | null;
  /** Ahead of the base, newest first */
  commits: Commit[];
  commitsMore: boolean;
  /** From the merge base with the base to the head */
  committed: ChangeSide;
  /** From the head to the work tree, staged or not */
  uncommitted: ChangeSide;
  untracked: string[];
  untrackedMore: boolean;
  hidden: number;
}
export interface Changes { repo: Repo | null; note: string | null }

export const changesApi = {
  /** One read of the session's work tree; nothing polls it (MCR-139) */
  read: (id: string) => invoke<Changes>('harness_changes', { id }),
};

export type Which = 'committed' | 'uncommitted';
export const fileKey = (which: Which, path: string) => `${which}:${path}`;

export type LineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx' | 'hidden' | 'note';
export interface DiffLine { kind: LineKind; text: string }

/** What Rust puts in place of a credential line (`changes::HIDDEN`) */
export const HIDDEN = '··· hidden: this line has the shape of a credential';

/** A file's diff as lines to draw: the header, hunk marks, added, removed, context. */
export function diffLines(diff: string): DiffLine[] {
  const lines = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n');
  let inHunk = false;
  return lines.map((text): DiffLine => {
    if (text.startsWith('@@')) { inHunk = true; return { kind: 'hunk', text }; }
    if (text.startsWith('diff --git ')) inHunk = false;
    if (!inHunk) return { kind: 'meta', text };
    if (text.slice(1) === HIDDEN) return { kind: 'hidden', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    if (text.startsWith('\\')) return { kind: 'note', text };
    return { kind: 'ctx', text };
  });
}

/** "+12 −3", or "binary" */
export function counts(f: ChangedFile): string {
  if (f.binary) return 'binary';
  if (f.added == null || f.removed == null) return '';
  return `+${f.added} −${f.removed}`;
}

/** Lines added and removed over a side's files */
export function sideTotals(side: ChangeSide): { files: number; added: number; removed: number } {
  return side.files.reduce((t, f) => ({ files: t.files + 1, added: t.added + (f.added ?? 0), removed: t.removed + (f.removed ?? 0) }), { files: 0, added: 0, removed: 0 });
}

/** "2 ahead, 1 behind", "even" */
export function aheadBehind(t: Track): string {
  if (!t.ahead && !t.behind) return 'even';
  return [t.ahead ? `${t.ahead} ahead` : '', t.behind ? `${t.behind} behind` : ''].filter(Boolean).join(', ');
}

/** Where an uncommitted change sits */
export function stagedLabel(f: ChangedFile): string {
  return f.staged && f.unstaged ? 'staged, changed since' : f.staged ? 'staged' : 'not staged';
}

/** The file to show first: the one still selected, else the first with a diff, else the first */
export function pickFile(repo: Repo, held: string): string {
  const all = [
    ...repo.uncommitted.files.map(f => ({ key: fileKey('uncommitted', f.path), f })),
    ...repo.committed.files.map(f => ({ key: fileKey('committed', f.path), f })),
  ];
  if (all.some(x => x.key === held)) return held;
  return (all.find(x => x.f.diff) ?? all[0])?.key ?? '';
}

export function findFile(repo: Repo, key: string): ChangedFile | null {
  const at = key.indexOf(':');
  const which = key.slice(0, at) as Which; const path = key.slice(at + 1);
  const side = which === 'committed' ? repo.committed : which === 'uncommitted' ? repo.uncommitted : null;
  return side?.files.find(f => f.path === path) ?? null;
}
