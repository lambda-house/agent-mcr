import type { HTMLAttributes } from 'react'
import { cx } from './cx'

export type StatusDotTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusDotTone
  pulse?: boolean
  size?: 'sm' | 'md'
  label?: string
}

const css = `
@layer teob-ui {
.ui-status-dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-12);
  color: var(--text-soft);
}
.ui-status-dot__pip {
  display: inline-block;
  flex: none;
  border-radius: var(--r-full);
  background: var(--text-muted);
}
.ui-status-dot__pip--sm { width: 6px; height: 6px; }
.ui-status-dot__pip--md { width: 8px; height: 8px; }
.ui-status-dot__pip--neutral { background: var(--text-muted); }
.ui-status-dot__pip--accent { background: var(--accent); }
.ui-status-dot__pip--success {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-bg);
}
.ui-status-dot__pip--warn {
  background: var(--warn);
  box-shadow: 0 0 0 3px var(--warn-bg);
}
.ui-status-dot__pip--danger {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-bg);
}
.ui-status-dot__pip--pulse {
  animation: ui-status-dot-pulse 2s var(--ease-standard) infinite;
}
@keyframes ui-status-dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-status-dot__pip--pulse { animation: none; }
}
}
`

export function StatusDot({
  tone = 'neutral',
  pulse = false,
  size = 'md',
  label,
  className,
  ...rest
}: StatusDotProps) {
  return (
    <>
      <style href="ui-status-dot" precedence="default">{css}</style>
      <span className={cx('ui-status-dot', className)} {...rest}>
        <span
          className={cx(
            'ui-status-dot__pip',
            `ui-status-dot__pip--${size}`,
            `ui-status-dot__pip--${tone}`,
            pulse && 'ui-status-dot__pip--pulse',
          )}
          aria-hidden="true"
        />
        {label && <span>{label}</span>}
      </span>
    </>
  )
}
