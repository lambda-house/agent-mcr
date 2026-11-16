import { cx } from './cx'

export type ProgressTone = 'accent' | 'ok' | 'warn' | 'danger'

export interface ProgressProps {
  /** 0..1; values outside are clamped. */
  value: number
  tone?: ProgressTone
  /** Accessible name for the bar. */
  label?: string
  className?: string
}

const css = `
@layer teob-ui {
.ui-progress {
  width: 100%;
  height: 4px;
  overflow: hidden;
  background: var(--bg-selected);
  border-radius: var(--r-full);
}
.ui-progress__bar {
  height: 100%;
  border-radius: var(--r-full);
  background: var(--accent);
  transition: width var(--dur-slow) var(--ease-standard);
}
.ui-progress--ok .ui-progress__bar { background: var(--ok); }
.ui-progress--warn .ui-progress__bar { background: var(--warn); }
.ui-progress--danger .ui-progress__bar { background: var(--danger); }
@media (prefers-reduced-motion: reduce) {
  .ui-progress__bar { transition: none; }
}
}
`

export function Progress({ value, tone = 'accent', label, className }: ProgressProps) {
  const ratio = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  const percent = Math.round(ratio * 100)
  return (
    <>
      <style href="ui-progress" precedence="default">{css}</style>
      <div
        className={cx('ui-progress', tone !== 'accent' && `ui-progress--${tone}`, className)}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label}
      >
        <div className="ui-progress__bar" style={{ width: `${percent}%` }} />
      </div>
    </>
  )
}
