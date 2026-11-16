import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { cx } from './cx'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  label: ReactNode
  children: ReactNode
  side?: TooltipSide
  className?: string
}

const css = `
@layer teob-ui {
.ui-tooltip { position: relative; display: inline-flex; align-items: center; }
.ui-tooltip__bubble {
  position: absolute;
  z-index: 60;
  max-width: 280px;
  padding: 5px 8px;
  font-size: var(--fs-11);
  line-height: 1.4;
  color: var(--text-inverse);
  background: var(--text);
  border-radius: var(--r-sm);
  box-shadow: var(--shadow-sm);
  pointer-events: none;
  white-space: normal;
  width: max-content;
  animation: ui-tooltip-in var(--dur-fast) var(--ease-standard);
}
.ui-tooltip__bubble--top { left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%); }
.ui-tooltip__bubble--bottom { left: 50%; top: calc(100% + 6px); transform: translateX(-50%); }
.ui-tooltip__bubble--left { right: calc(100% + 6px); top: 50%; transform: translateY(-50%); }
.ui-tooltip__bubble--right { left: calc(100% + 6px); top: 50%; transform: translateY(-50%); }
@keyframes ui-tooltip-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .ui-tooltip__bubble { animation: none; }
}
}
`

export function Tooltip({ label, children, side = 'top', className }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)
  const id = useId()
  const tooltipId = `${id}-tooltip`

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }

  const show = (delay: number) => {
    clear()
    timer.current = window.setTimeout(() => setOpen(true), delay)
  }

  const hide = () => {
    clear()
    setOpen(false)
  }

  useEffect(() => clear, [])

  const described = open ? tooltipId : undefined
  const child = isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
        'aria-describedby':
          [children.props['aria-describedby'], described].filter(Boolean).join(' ') || undefined,
      })
    : children

  return (
    <>
      <style href="ui-tooltip" precedence="default">{css}</style>
      <span
        className={cx('ui-tooltip', className)}
        onMouseEnter={() => show(400)}
        onMouseLeave={hide}
        onFocus={() => show(0)}
        onBlur={hide}
      >
        {child}
        {open && (
          <span id={tooltipId} role="tooltip" className={cx('ui-tooltip__bubble', `ui-tooltip__bubble--${side}`)}>
            {label}
          </span>
        )}
      </span>
    </>
  )
}
