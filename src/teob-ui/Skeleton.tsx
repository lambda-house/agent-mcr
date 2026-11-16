import type { CSSProperties } from 'react'
import { cx } from './cx'

export interface SkeletonProps {
  width?: number | string
  height?: number | string
  radius?: number | string
  className?: string
  style?: CSSProperties
}

const css = `
@layer teob-ui {
.ui-skeleton {
  display: inline-block;
  max-width: 100%;
  background: linear-gradient(90deg, var(--bg-hover) 8%, var(--bg-selected) 38%, var(--bg-hover) 68%);
  background-size: 200% 100%;
  animation: ui-skeleton-sweep 1.4s linear infinite;
}
@keyframes ui-skeleton-sweep { from { background-position: 150% 0; } to { background-position: -50% 0; } }
@media (prefers-reduced-motion: reduce) {
  .ui-skeleton { animation: none; background: var(--bg-hover); }
}
}
`

/** A placeholder of the real row's size; one shared shimmer for every skeleton on the page. The caller owns the
 *  `aria-busy`/`aria-live` wrapper. */
export function Skeleton({ width = '100%', height = 12, radius = 'var(--r-sm)', className, style }: SkeletonProps) {
  return (
    <>
      <style href="ui-skeleton" precedence="default">{css}</style>
      <span
        aria-hidden="true"
        className={cx('ui-skeleton', className)}
        style={{ width, height, borderRadius: radius, ...style }}
      />
    </>
  )
}
