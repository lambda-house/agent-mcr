import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Popover } from './Popover'
import { cx } from './cx'

export interface MenuItem {
  label: string
  onSelect: () => void
  icon?: ReactNode
  danger?: boolean
  /** A key hint, e.g. `⌘⌫`, shown right-aligned. */
  shortcut?: string
  disabled?: boolean
}

export interface MenuProps {
  trigger: ReactNode
  items: MenuItem[]
  /** Non-interactive text above the items (who is signed in, say). */
  header?: ReactNode
  align?: 'start' | 'end'
  /** Names the menu button; the trigger's own text is used otherwise. */
  ariaLabel?: string
  /** For the showcase: open on mount. */
  defaultOpen?: boolean
  className?: string
}

const css = `
@layer teob-ui {
.ui-menu { position: relative; display: inline-flex; }
.ui-menu__trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  color: var(--text-soft);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  transition: background-color var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard);
}
.ui-menu__trigger[aria-expanded='true'] { background: var(--bg-hover); color: var(--text); }
@media (hover: hover) {
  .ui-menu__trigger:hover { background: var(--bg-hover); color: var(--text); }
}
.ui-menu__panel { padding: 4px; min-width: 200px; max-width: 320px; }
.ui-menu__header { padding: 6px 8px 8px; margin-bottom: 4px; border-bottom: 1px solid var(--line); font-size: var(--fs-12); color: var(--text-muted); overflow-wrap: anywhere; }
.ui-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  font-family: inherit;
  font-size: var(--fs-12);
  text-align: left;
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: var(--r-xs);
  cursor: pointer;
}
.ui-menu__item:focus-visible { background: var(--bg-hover); }
@media (hover: hover) {
  .ui-menu__item:hover { background: var(--bg-hover); }
}
.ui-menu__item--danger { color: var(--danger); }
.ui-menu__item[disabled] { color: var(--text-faint); cursor: not-allowed; }
.ui-menu__item-icon { display: inline-flex; color: var(--text-muted); }
.ui-menu__item--danger .ui-menu__item-icon { color: inherit; }
.ui-menu__item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-menu__shortcut { font-family: var(--font-mono); font-size: var(--fs-11); color: var(--text-muted); }
@media (prefers-reduced-motion: reduce) {
  .ui-menu__trigger { transition: none; }
}
}
`

export function Menu({ trigger, items, header, align = 'start', ariaLabel, defaultOpen = false, className }: MenuProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [returnFocus, setReturnFocus] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()
  const menuId = `${id}-menu`
  const triggerId = `${id}-trigger`

  useEffect(() => {
    if (open || !returnFocus) return
    setReturnFocus(false)
    triggerRef.current?.focus()
  }, [open, returnFocus])

  const close = (focusTrigger = false) => {
    if (focusTrigger) setReturnFocus(true)
    setOpen(false)
  }

  const enabledIndexes = () => itemRefs.current.map((element, index) => (element && !element.disabled ? index : -1)).filter((index) => index >= 0)

  const focusItem = (position: 'first' | 'last') => {
    if (!open) setOpen(true)
    window.setTimeout(() => {
      const enabled = enabledIndexes()
      if (enabled.length === 0) return
      itemRefs.current[position === 'first' ? enabled[0] : enabled[enabled.length - 1]]?.focus()
    }, 0)
  }

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = enabledIndexes()
    if (enabled.length === 0) return
    const current = itemRefs.current.findIndex((element) => element === document.activeElement)
    let next: number
    if (event.key === 'ArrowDown') next = enabled[(enabled.indexOf(current) + 1) % enabled.length]
    else if (event.key === 'ArrowUp') next = enabled[(enabled.indexOf(current) - 1 + enabled.length) % enabled.length]
    else if (event.key === 'Home') next = enabled[0]
    else if (event.key === 'End') next = enabled[enabled.length - 1]
    else return
    event.preventDefault()
    itemRefs.current[next]?.focus()
  }

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else {
      move(event)
    }
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusItem(event.key === 'ArrowDown' ? 'first' : 'last')
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
    }
  }

  return (
    <>
      <style href="ui-menu" precedence="default">{css}</style>
      <Popover
        open={open}
        onOpenChange={setOpen}
        align={align}
        className={cx('ui-menu', className)}
        triggerClassName="ui-menu__trigger"
        hasPopup="menu"
        triggerRef={triggerRef}
        triggerProps={{
          id: triggerId,
          'aria-label': ariaLabel,
          'aria-controls': open ? menuId : undefined,
          onKeyDown: onTriggerKeyDown,
        }}
        trigger={trigger}
      >
        <div id={menuId} role="menu" aria-labelledby={triggerId} className="ui-menu__panel" onKeyDown={onPanelKeyDown}>
          {header && <div className="ui-menu__header" role="presentation">{header}</div>}
          {items.map((item, index) => (
            <button
              key={`${item.label}-${index}`}
              ref={(element) => {
                itemRefs.current[index] = element
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={cx('ui-menu__item', item.danger && 'ui-menu__item--danger')}
              disabled={item.disabled}
              onClick={() => {
                item.onSelect()
                close(true)
              }}
            >
              {item.icon && <span className="ui-menu__item-icon" aria-hidden="true">{item.icon}</span>}
              <span className="ui-menu__item-label">{item.label}</span>
              {item.shortcut && <span className="ui-menu__shortcut">{item.shortcut}</span>}
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}
