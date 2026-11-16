import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { cx } from './cx'
import { m, motionEnter } from './motion'

export interface TabsProps<K extends string> {
  tabs: [key: K, label: string][]
  value: K
  onChange: (key: K) => void
  variant?: 'underline' | 'segmented'
  /** Numbers shown after a label, e.g. pending decisions or instances. */
  counts?: Partial<Record<K, number>>
  'aria-label'?: string
  className?: string
}

const css = `
@layer teob-ui {
.ui-tabs { display: flex; align-items: stretch; min-width: 0; }
.ui-tabs--underline { margin-bottom: var(--gap-group); gap: 2px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
.ui-tabs--underline::-webkit-scrollbar { display: none; }
.ui-tabs__tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 0 10px;
  height: 40px;
  font-family: inherit;
  font-size: var(--fs-12);
  font-weight: 500;
  color: var(--text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm) var(--r-sm) 0 0;
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--dur-fast) var(--ease-standard), background-color var(--dur-fast) var(--ease-standard);
}
@media (hover: hover) {
  .ui-tabs__tab:hover { color: var(--text); background: var(--bg-hover); }
  .ui-tabs--segmented .ui-tabs__tab:hover { background: transparent; color: var(--text); }
}
.ui-tabs__tab--active { color: var(--text); font-weight: 600; }
.ui-tabs--underline .ui-tabs__tab--active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--accent);
  border-radius: var(--r-full);
}
.ui-tabs__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  font-size: var(--fs-11);
  font-weight: 500;
  line-height: 1;
  color: var(--text-soft);
  background: var(--bg-selected);
  border-radius: var(--r-full);
}
.ui-tabs__tab--active .ui-tabs__count { background: var(--accent-bg); color: var(--accent); }

.ui-tabs--segmented {
  position: relative;
  width: fit-content;
  max-width: 100%;
  gap: 2px;
  padding: 3px;
  /* a filled pill track with no border, so a mode switch never reads as an input or a button row */
  background: var(--segmented-track);
  border-radius: var(--r-full);
  overflow-x: auto;
  scrollbar-width: none;
}
.ui-tabs--segmented::-webkit-scrollbar { display: none; }
.ui-tabs--segmented .ui-tabs__tab {
  height: 26px;
  padding: 0 12px;
  border-radius: var(--r-full);
  font-size: var(--fs-12);
  font-weight: 500;
  color: var(--text-muted);
  z-index: 1;
}
.ui-tabs--segmented .ui-tabs__tab--active { color: var(--text); }
.ui-tabs__indicator {
  position: absolute;
  top: 3px;
  left: 0;
  height: 26px;
  background: var(--segmented-thumb);
  border-radius: var(--r-full);
  box-shadow: var(--segmented-thumb-shadow);
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .ui-tabs__tab { transition: none; }
}
}
`

export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  variant = 'underline',
  counts,
  className,
  'aria-label': ariaLabel,
}: TabsProps<K>) {
  const list = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<K, HTMLButtonElement>())
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)
  const signature = tabs.map(([key, label]) => `${key}:${label}`).join('|')
  const activeIndex = tabs.findIndex(([key]) => key === value)
  const hasActive = activeIndex >= 0

  useLayoutEffect(() => {
    if (variant !== 'segmented') return
    const update = () => {
      const el = buttons.current.get(value)
      setIndicator(el ? { left: el.offsetLeft, width: el.offsetWidth } : null)
    }
    update()
    window.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (list.current) observer?.observe(list.current)
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [signature, value, variant])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1
    let next = index
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else return
    event.preventDefault()
    const key = tabs[next][0]
    onChange(key)
    buttons.current.get(key)?.focus()
  }

  return (
    <>
      <style href="ui-tabs" precedence="default">{css}</style>
      <div
        ref={list}
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        className={cx('ui-tabs', `ui-tabs--${variant}`, className)}
      >
        {variant === 'segmented' && indicator && (
          <m.span
            className="ui-tabs__indicator"
            aria-hidden="true"
            initial={false}
            animate={{ x: indicator.left, width: indicator.width, transition: motionEnter }}
          />
        )}
        {tabs.map(([key, label], index) => (
          <button
            key={key}
            ref={(el) => {
              if (el) buttons.current.set(key, el)
              else buttons.current.delete(key)
            }}
            type="button"
            role="tab"
            aria-selected={value === key}
            tabIndex={value === key || (!hasActive && index === 0) ? 0 : -1}
            className={cx('ui-tabs__tab', value === key && 'ui-tabs__tab--active')}
            onClick={() => onChange(key)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {label}
            {counts?.[key] !== undefined && <span className="ui-tabs__count">{counts[key]}</span>}
          </button>
        ))}
      </div>
    </>
  )
}

export interface SegmentedControlProps<K extends string> extends Omit<TabsProps<K>, 'variant'> {}

/** The page-tab control: a gliding pill, 28 px tall, counts inside the pill. Shares `Tabs`' keyboard behaviour. */
export function SegmentedControl<K extends string>(props: SegmentedControlProps<K>) {
  return <Tabs<K> {...props} variant="segmented" />
}
