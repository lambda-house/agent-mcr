import { describe, expect, it } from 'vitest';
import { aheadBehind, counts, diffLines, fileKey, findFile, HIDDEN, pickFile, sideTotals, stagedLabel, type ChangedFile, type Repo } from './changes';

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path, status: 'M', staged: false, unstaged: true, added: 1, removed: 0, binary: false, diff: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n+x\n`, diffNote: null, hidden: 0, undone: false, ...over,
});
const repo = (over: Partial<Repo> = {}): Repo => ({
  root: '/w', branch: 'main', head: 'a'.repeat(40), base: null, baseNote: null, upstream: null, commits: [], commitsMore: false,
  committed: { files: [], more: false, note: null }, uncommitted: { files: [], more: false, note: null }, untracked: [], untrackedMore: false, hidden: 0, ...over,
});

describe('Changes helpers', () => {
  it('reads a diff as header, hunks, added, removed, context and hidden lines', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt', 'index 1..2 100644', '--- a/a.txt', '+++ b/a.txt', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', `+${HIDDEN}`, '\\ No newline at end of file', '',
    ].join('\n');
    expect(diffLines(diff).map(l => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'hidden', 'note']);
    // The header's --- and +++ are not removed and added lines
    expect(diffLines(diff)[2]).toEqual({ kind: 'meta', text: '--- a/a.txt' });
  });

  it('counts, totals and says where a change sits', () => {
    expect(counts(file('a', { added: 12, removed: 3 }))).toBe('+12 −3');
    expect(counts(file('b', { binary: true, added: null, removed: null }))).toBe('binary');
    expect(sideTotals({ files: [file('a', { added: 2, removed: 1 }), file('b', { added: null, removed: null, binary: true })], more: false, note: null })).toEqual({ files: 2, added: 2, removed: 1 });
    expect([stagedLabel(file('a', { staged: true, unstaged: false })), stagedLabel(file('a')), stagedLabel(file('a', { staged: true }))]).toEqual(['staged', 'not staged', 'staged, changed since']);
    expect([aheadBehind({ name: 'o', ahead: 0, behind: 0, mergeBase: null }), aheadBehind({ name: 'o', ahead: 2, behind: 1, mergeBase: null }), aheadBehind({ name: 'o', ahead: 0, behind: 4, mergeBase: null })]).toEqual(['even', '2 ahead, 1 behind', '4 behind']);
  });

  it('keeps the chosen file while it is there, else shows the first with a diff', () => {
    const r = repo({ uncommitted: { files: [file('big', { diff: null, diffNote: 'too large' }), file('u')], more: false, note: null }, committed: { files: [file('c')], more: false, note: null } });
    expect(pickFile(r, '')).toBe(fileKey('uncommitted', 'u'));
    expect(pickFile(r, fileKey('committed', 'c'))).toBe('committed:c');
    expect(pickFile(r, fileKey('committed', 'gone'))).toBe('uncommitted:u');
    expect(findFile(r, 'committed:c')?.path).toBe('c');
    // A path with a colon in it is still found
    const colon = repo({ committed: { files: [file('a:b')], more: false, note: null } });
    expect(findFile(colon, fileKey('committed', 'a:b'))?.path).toBe('a:b');
    expect(pickFile(repo(), '')).toBe('');
  });
});
