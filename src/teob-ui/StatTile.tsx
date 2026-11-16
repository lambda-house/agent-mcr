import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { cx } from './cx'

export type StatTone = 'default' | 'accent' | 'ok' | 'warn' | 'danger'

export interface StatTileProps {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  tone?: StatTone
  /** A glyph for the subject, top right. */
  icon?: IconName
  trend?: { direction: 'up' | 'down'; label: string }
  className?: string
}

const css = `
@layer teob-ui {
.ui-stat {
  min-width: 0;
  padding: 14px var(--sp-4);
  background: var(--layer-1);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}
.ui-stat__top { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-tight); }
.ui-stat__label { font-size: var(--fs-12); color: var(--text-muted); }
.ui-stat__icon { display: inline-flex; color: var(--text-faint); }
.ui-stat__value-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.ui-stat__value {
  font-size: var(--fs-24);
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.ui-stat--accent .ui-stat__value { color: var(--accent); }
.ui-stat--ok .ui-stat__value { color: var(--ok); }
.ui-stat--warn .ui-stat__value { color: var(--warn); }
.ui-stat--danger .ui-stat__value { color: var(--danger); }
.ui-stat__trend { font-size: var(--fs-12); color: var(--text-muted); white-space: nowrap; }
.ui-stat__trend--up { color: var(--ok); }
.ui-stat__trend--down { color: var(--danger); }
.ui-stat__hint { margin-top: 2px; font-size: var(--fs-12); color: var(--text-soft); }
}
`

export function StatTile({ label, value, hint, tone = 'default', icon, trend, className }: StatTileProps) {
  return (
    <>
      <style href="ui-stat-tile" precedence="default">{css}</style>
      <div className={cx('ui-stat', `ui-stat--${tone}`, className)}>
        <div className="ui-stat__top">
          <div className="ui-stat__label">{label}</div>
          {icon && (
            <span className="ui-stat__icon" aria-hidden="true">
              <Icon name={icon} size={16} />
            </span>
          )}
        </div>
        <div className="ui-stat__value-row">
          <span className="ui-stat__value">{value}</span>
          {trend && (
            <span className={cx('ui-stat__trend', `ui-stat__trend--${trend.direction}`)}>
              {trend.direction === 'up' ? '↑' : '↓'} {trend.label}
            </span>
          )}
        </div>
        {hint && <div className="ui-stat__hint">{hint}</div>}
      </div>
    </>
  )
}
