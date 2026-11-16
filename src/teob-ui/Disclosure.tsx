import { useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { cx } from './cx'

export interface DisclosureProps {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
}

const css = `
@layer teob-ui {
.ui-disclosure { border-top: 1px solid var(--line); }
.ui-disclosure:first-child { border-top: 0; }
.ui-disclosure__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 4px;
  font-size: var(--fs-13);
  font-weight: 500;
  color: var(--text-soft);
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.ui-disclosure__summary::-webkit-details-marker { display: none; }
.ui-disclosure__summary::marker { content: ''; }
.ui-disclosure__chevron { display: inline-flex; color: var(--text-muted); transition: transform var(--dur-fast) var(--ease-standard); }
.ui-disclosure[open] .ui-disclosure__chevron { transform: rotate(90deg); }
.ui-disclosure__content { padding: 0 4px var(--gap-group); }
@media (hover: hover) {
  .ui-disclosure__summary:hover { color: var(--text); }
}
@media (prefers-reduced-motion: reduce) {
  .ui-disclosure__chevron { transition: none; }
}
}
`

export function Disclosure({ summary, children, defaultOpen = false, className }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <>
      <style href="ui-disclosure" precedence="default">{css}</style>
      <details className={cx('ui-disclosure', className)} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="ui-disclosure__summary">
          <span className="ui-disclosure__chevron" aria-hidden="true">
            <Icon name="chevronRight" size={16} />
          </span>
          {summary}
        </summary>
        {open && <div className="ui-disclosure__content">{children}</div>}
      </details>
    </>
  )
}
