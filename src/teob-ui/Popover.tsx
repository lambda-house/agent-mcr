import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react'
import { cx } from './cx'
import { AnimatePresence, m, motionEnter, motionExit } from './motion'

export interface PopoverProps {
  trigger: ReactNode
  children: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  align?: 'start' | 'end'
  className?: string
  triggerClassName?: string
  /** `menu`, `dialog`, `listbox` or `true`; defaults to `dialog`. */
  hasPopup?: 'menu' | 'dialog' | 'listbox' | true
  /** The panel's accessible name; with one the panel is a dialog. */
  ariaLabel?: string
  /** Extra props for the trigger button (a key handler, an aria-controls). */
  triggerProps?: ButtonHTMLAttributes<HTMLButtonElement>
  /** A caller's handle on the trigger, for returning focus to it. */
  triggerRef?: RefObject<HTMLButtonElement | null>
  panelRef?: RefObject<HTMLDivElement | null>
  /** The panel's own role; a Menu supplies `menu` on its inner element and leaves this unset. */
  panelRole?: 'dialog' | 'group'
}

const css = `
@layer teob-ui {
.ui-popover { position: relative; display: inline-flex; }
.ui-popover__trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  font-family: inherit;
  font-size: var(--fs-12);
  color: var(--text-soft);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  cursor: pointer;
  white-space: nowrap;
}
.ui-popover__panel {
  position: absolute;
  top: calc(100% + 8px);
  z-index: 70;
  min-width: 220px;
  max-width: min(360px, calc(100vw - 24px));
  padding: 4px;
  background: var(--surface-1);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-md);
}
.ui-popover__panel--start { left: 0; }
.ui-popover__panel--end { right: 0; }
}
`

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = 'start',
  className,
  triggerClassName,
  hasPopup = 'dialog',
  ariaLabel,
  triggerProps,
  triggerRef,
  panelRef,
  panelRole,
}: PopoverProps) {
  const root = useRef<HTMLDivElement>(null)
  const ownTrigger = useRef<HTMLButtonElement>(null)
  const button = triggerRef ?? ownTrigger
  const returnFocus = useRef(false)

  useEffect(() => {
    if (!open) {
      if (returnFocus.current) {
        returnFocus.current = false
        button.current?.focus()
      }
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onOpenChange(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      returnFocus.current = true
      onOpenChange(false)
    }
    const onFocusIn = (event: FocusEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onOpenChange(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [open, onOpenChange])

  return (
    <>
      <style href="ui-popover" precedence="default">{css}</style>
      <div ref={root} className={cx('ui-popover', className)}>
        <button
          {...triggerProps}
          ref={button as RefObject<HTMLButtonElement>}
          type="button"
          className={cx('ui-popover__trigger', triggerClassName)}
          aria-haspopup={hasPopup}
          aria-expanded={open}
          onClick={(event) => {
            triggerProps?.onClick?.(event)
            if (!event.defaultPrevented) onOpenChange(!open)
          }}
        >
          {trigger}
        </button>
        <AnimatePresence>
          {open && (
            <m.div
              ref={panelRef as RefObject<HTMLDivElement> | undefined}
              className={cx('ui-popover__panel', `ui-popover__panel--${align}`)}
              role={panelRole ?? (ariaLabel ? 'dialog' : undefined)}
              aria-label={ariaLabel}
              style={{ transformOrigin: align === 'end' ? 'top right' : 'top left' }}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1, transition: motionEnter }}
              exit={{ opacity: 0, scale: 0.97, transition: motionExit }}
            >
              {children}
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
