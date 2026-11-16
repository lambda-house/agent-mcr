import { cx } from './cx'

export type DiffLineKind = 'same' | 'added' | 'removed'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export interface DiffViewProps {
  /** A line-by-line diff of the two texts; ignored when `lines` is given. */
  before?: string
  after?: string
  lines?: DiffLine[]
  className?: string
}

const css = `
@layer teob-ui {
.ui-diff {
  max-height: 320px;
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--bg-subtle);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 1.55;
}
.ui-diff__line { display: flex; align-items: flex-start; gap: 8px; padding: 1px 10px 1px 0; }
.ui-diff__sign {
  flex: none;
  width: 24px;
  padding-left: 8px;
  text-align: center;
  color: var(--text-faint);
  user-select: none;
}
.ui-diff__text { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-soft); }
.ui-diff__line--same .ui-diff__text { color: var(--text-muted); }
.ui-diff__line--added { background: var(--ok-bg); }
.ui-diff__line--added .ui-diff__sign { color: var(--ok); }
.ui-diff__line--added .ui-diff__text { color: var(--text); }
.ui-diff__line--removed { background: var(--danger-bg); }
.ui-diff__line--removed .ui-diff__sign { color: var(--danger); }
.ui-diff__line--removed .ui-diff__text { color: var(--text); }
.ui-diff--empty { padding: 14px 12px; font-family: var(--font-sans); font-size: var(--fs-12); color: var(--text-muted); }
}
`

const sign: Record<DiffLineKind, string> = { same: '', added: '+', removed: '-' }

/** A line diff of two texts: a longest-common-subsequence walk, so unchanged lines stay quiet. */
function linesOf(before?: string, after?: string): DiffLine[] {
  const a = before === undefined ? [] : before.split('\n')
  const b = after === undefined ? [] : after.split('\n')
  // the table is (a.length + 1) x (b.length + 1); the texts here are schema summaries, not files
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i] })
      i++
    } else {
      out.push({ kind: 'added', text: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] })
  while (j < b.length) out.push({ kind: 'added', text: b[j++] })
  return out
}

/** What a proposal changes, before and after, in a quiet well: no interaction, names and values as text. */
export function DiffView({ before, after, lines, className }: DiffViewProps) {
  const rows = lines ?? linesOf(before, after)
  return (
    <>
      <style href="ui-diff-view" precedence="default">{css}</style>
      {rows.length === 0 ? (
        <div className={cx('ui-diff', 'ui-diff--empty', className)}>No text differs.</div>
      ) : (
        <div className={cx('ui-diff', className)} role="region" aria-label="Before and after">
          {rows.map((line, index) => (
            <div key={`${index}-${line.kind}`} className={cx('ui-diff__line', `ui-diff__line--${line.kind}`)}>
              <span className="ui-diff__sign" aria-hidden="true">
                {sign[line.kind]}
              </span>
              <span className="ui-diff__text">{line.text === '' ? ' ' : line.text}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
