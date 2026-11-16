import type { CSSProperties, ReactNode } from 'react'
import { cx } from './cx'

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'live'

export interface BadgeProps {
  children?: ReactNode
  tone?: BadgeTone
  /** A leading dot; `live` always shows one (its colour is never used for text). */
  dot?: boolean
  className?: string
  style?: CSSProperties
  title?: string
  'aria-label'?: string
}

const css = `
@layer teob-ui {
.ui-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  padding: 2px 10px;
  font-size: var(--fs-11);
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  border: 1px solid var(--line);
  border-radius: var(--r-full);
  background: var(--layer-2, var(--bg-subtle));
  color: var(--text-soft);
}
.ui-badge--accent { background: var(--accent-bg); border-color: var(--accent-line); color: var(--accent); }
.ui-badge--ok { background: var(--ok-bg); border-color: var(--ok-line); color: var(--ok); }
.ui-badge--warn { background: var(--warn-bg); border-color: var(--warn-line); color: var(--warn); }
.ui-badge--danger { background: var(--danger-bg); border-color: var(--danger-line); color: var(--danger); }
.ui-badge--info { background: var(--info-bg); border-color: var(--info-line); color: var(--info); }
.ui-badge--live { background: var(--ok-bg); border-color: var(--ok-line); color: var(--text-soft); }
.ui-badge__dot { width: 6px; height: 6px; border-radius: var(--r-full); background: currentColor; flex: none; }
.ui-badge--live .ui-badge__dot { background: var(--live); }
}
`

export function Badge({ children, tone = 'neutral', dot = false, className, style, title, ...aria }: BadgeProps) {
  return (
    <>
      <style href="ui-badge" precedence="default">{css}</style>
      <span
        className={cx('ui-badge', `ui-badge--${tone}`, className)}
        style={style}
        title={title}
        aria-label={aria['aria-label']}
      >
        {(dot || tone === 'live') && <span className="ui-badge__dot" aria-hidden="true" />}
        {children}
      </span>
    </>
  )
}
