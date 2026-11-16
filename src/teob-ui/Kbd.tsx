import type { ReactNode } from 'react'
import { cx } from './cx'

export interface KbdProps {
  children: ReactNode
  className?: string
}

const css = `
@layer teob-ui {
.ui-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 7px;
  font-family: var(--font-mono);
  font-size: var(--fs-11);
  line-height: 1;
  color: var(--text-muted);
  background: var(--layer-2, var(--bg-subtle));
  border: 1px solid var(--line);
  border-bottom-color: var(--line-strong);
  border-radius: var(--r-sm, var(--r-xs));
  white-space: nowrap;
}
}
`

export function Kbd({ children, className }: KbdProps) {
  return (
    <>
      <style href="ui-kbd" precedence="default">{css}</style>
      <kbd className={cx('ui-kbd', className)}>{children}</kbd>
    </>
  )
}
