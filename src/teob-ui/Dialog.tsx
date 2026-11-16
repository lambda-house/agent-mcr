import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'
import { Icon } from './Icon'
import { AnimatePresence, m, motionEnter, motionExit } from './motion'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}

const css = `
@layer teob-ui {
.ui-dialog__backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--overlay);
}
.ui-dialog {
  width: min(480px, 100%);
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-md);
  outline: none;
}
.ui-dialog__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px 10px;
}
.ui-dialog__title { flex: 1; min-width: 0; font-size: var(--fs-16); font-weight: 600; letter-spacing: -0.01em; color: var(--text); }
.ui-dialog__body { padding: 2px 16px 16px; overflow: auto; color: var(--text-soft); font-size: var(--fs-13); line-height: 1.5; }
.ui-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
}
}
`

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null)
  const restore = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const id = useId()
  const titleId = `${id}-title`

  useEffect(() => {
    if (!open) return
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const first = panel.current?.querySelector<HTMLElement>(focusable) ?? panel.current
    first?.focus()

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel.current) return
      const nodes = Array.from(panel.current.querySelectorAll<HTMLElement>(focusable)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement
      )
      if (nodes.length === 0) {
        event.preventDefault()
        panel.current.focus()
        return
      }
      const firstNode = nodes[0]
      const lastNode = nodes[nodes.length - 1]
      if (event.shiftKey && (document.activeElement === firstNode || document.activeElement === panel.current)) {
        event.preventDefault()
        lastNode.focus()
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault()
        firstNode.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      restore.current?.focus()
    }
  }, [open])

  return createPortal(
    <>
      <style href="ui-dialog" precedence="default">{css}</style>
      <AnimatePresence>
        {open && (
          <m.div
            key="backdrop"
            className="ui-dialog__backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: motionEnter }}
            exit={{ opacity: 0, transition: motionExit }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) onClose()
            }}
          >
            <m.div
              ref={panel}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
              className="ui-dialog"
              initial={{ opacity: 0, y: 4, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: motionEnter }}
              exit={{ opacity: 0, y: 4, scale: 0.985, transition: motionExit }}
            >
              <div className="ui-dialog__header">
                <div id={titleId} className="ui-dialog__title">
                  {title}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Close dialog"
                  icon={<Icon name="close" size={16} />}
                  onClick={onClose}
                />
              </div>
              <div className="ui-dialog__body">{children}</div>
              {footer && <div className="ui-dialog__footer">{footer}</div>}
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </>,
    document.body
  )
}
