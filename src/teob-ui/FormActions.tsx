import type { ReactNode } from 'react'
import { cx } from './cx'

export interface FormActionsProps {
  /** Status or a note about what the action does: muted, on the left of the same row. */
  note?: ReactNode
  /** The buttons, secondary first: the primary is the last one and sits at the end. */
  children: ReactNode
  /** No hairline above, for a row that already stands apart. */
  bare?: boolean
  className?: string
}

const css = `
@layer teob-ui {
.ui-form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--gap-tight) var(--gap-group);
  flex-wrap: wrap;
  margin-top: var(--gap-group);
  padding-top: var(--gap-group);
  border-top: 1px solid var(--line);
}
.ui-form-actions--bare { padding-top: 0; border-top: 0; }
.ui-form-actions__note { flex: 1 1 200px; min-width: 0; font-size: var(--fs-12); line-height: 1.5; color: var(--text-muted); }
.ui-form-actions__buttons { display: flex; align-items: center; justify-content: flex-end; gap: var(--gap-tight); flex-wrap: wrap; margin-inline-start: auto; }
}
`

/** The end of a form or a step: what completes it, right-aligned (the primary last, a secondary to its left), with
 *  status or a note on the left, set apart from the content above. */
export function FormActions({ note, children, bare = false, className }: FormActionsProps) {
  return (
    <>
      <style href="ui-form-actions" precedence="default">{css}</style>
      <div className={cx('ui-form-actions', bare && 'ui-form-actions--bare', className)}>
        {note && <span className="ui-form-actions__note">{note}</span>}
        <span className="ui-form-actions__buttons">{children}</span>
      </div>
    </>
  )
}
