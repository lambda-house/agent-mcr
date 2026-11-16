import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cx } from './cx'
import { Icon, type IconName } from './Icon'

export type ToastTone = 'neutral' | 'ok' | 'warn' | 'danger'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  title: string
  description?: string
  tone?: ToastTone
  action?: ToastAction
}

interface ToastRecord extends ToastOptions {
  id: number
  leaving: boolean
}

const MAX_VISIBLE = 4
const LIFETIME = 6000
const EXIT = 140

const css = `
@layer teob-ui {
.ui-toaster {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
}
.ui-toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: min(360px, calc(100vw - 32px));
  padding: 10px 10px 10px 12px;
  background: var(--surface-1);
  border: 1px solid var(--line);
  border-left: 2px solid var(--line-strong);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-md);
  pointer-events: auto;
  animation: ui-toast-in var(--dur-base) var(--ease-enter);
}
.ui-toast--ok { border-left-color: var(--ok); }
.ui-toast--warn { border-left-color: var(--warn); }
.ui-toast--danger { border-left-color: var(--danger); }
.ui-toast--neutral { border-left-color: var(--accent); }
.ui-toast--leaving { opacity: 0; transform: translateX(8px); transition: opacity var(--dur-base) var(--ease-exit), transform var(--dur-base) var(--ease-exit); }
.ui-toast__icon { display: inline-flex; padding-top: 1px; color: var(--text-muted); }
.ui-toast--ok .ui-toast__icon { color: var(--ok); }
.ui-toast--warn .ui-toast__icon { color: var(--warn); }
.ui-toast--danger .ui-toast__icon { color: var(--danger); }
.ui-toast--neutral .ui-toast__icon { color: var(--accent); }
.ui-toast__main { flex: 1; min-width: 0; }
.ui-toast__title { font-size: var(--fs-13); font-weight: 600; color: var(--text); }
.ui-toast__description { margin-top: 2px; font-size: var(--fs-12); color: var(--text-soft); }
.ui-toast__action {
  margin-top: 6px;
  padding: 0;
  font-family: inherit;
  font-size: var(--fs-12);
  font-weight: 500;
  color: var(--accent);
  background: none;
  border: 0;
  cursor: pointer;
}
@media (hover: hover) {
  .ui-toast__action:hover { text-decoration: underline; }
}
.ui-toast__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  color: var(--text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--r-xs);
  cursor: pointer;
}
@media (hover: hover) {
  .ui-toast__close:hover { background: var(--bg-hover); color: var(--text); }
}
@keyframes ui-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .ui-toast { animation: none; }
  .ui-toast--leaving { transition: none; }
}
}
`

const icons: Record<ToastTone, IconName> = {
  neutral: 'info',
  ok: 'check',
  warn: 'alert',
  danger: 'alert',
}

const ToastContext = createContext<{ toast: (options: ToastOptions) => void } | null>(null)

let emit: ((options: ToastOptions) => void) | null = null

/** Show a toast from anywhere once a `ToastProvider` is mounted. */
export function toast(options: ToastOptions): void {
  emit?.(options)
}

/** The toasts of this provider, for components below it. */
export function useToast(): { toast: (options: ToastOptions) => void } {
  const context = useContext(ToastContext)
  if (!context) return { toast }
  return context
}

interface ToastItemProps {
  record: ToastRecord
  onDismiss: (id: number) => void
}

function ToastItem({ record, onDismiss }: ToastItemProps) {
  const [paused, setPaused] = useState(false)
  const remaining = useRef(LIFETIME)
  const started = useRef(0)

  useEffect(() => {
    if (record.leaving || paused) return
    started.current = Date.now()
    const timer = window.setTimeout(() => onDismiss(record.id), Math.max(remaining.current, 0))
    return () => {
      window.clearTimeout(timer)
      remaining.current -= Date.now() - started.current
    }
  }, [paused, record.leaving, record.id, onDismiss])

  const tone = record.tone ?? 'neutral'
  return (
    <div
      className={cx('ui-toast', `ui-toast--${tone}`, record.leaving && 'ui-toast--leaving')}
      role={tone === 'danger' ? 'alert' : undefined}
      aria-atomic={tone === 'danger' ? 'true' : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className="ui-toast__icon" aria-hidden="true">
        <Icon name={icons[tone]} size={16} />
      </span>
      <div className="ui-toast__main">
        <div className="ui-toast__title">{record.title}</div>
        {record.description && <div className="ui-toast__description">{record.description}</div>}
        {record.action && (
          <button
            type="button"
            className="ui-toast__action"
            onClick={() => {
              record.action?.onClick()
              onDismiss(record.id)
            }}
          >
            {record.action.label}
          </button>
        )}
      </div>
      <button type="button" className="ui-toast__close" aria-label="Dismiss notification" onClick={() => onDismiss(record.id)}>
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<ToastRecord[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setRecords((current) => current.map((record) => (record.id === id ? { ...record, leaving: true } : record)))
    window.setTimeout(() => {
      setRecords((current) => current.filter((record) => record.id !== id))
    }, EXIT)
  }, [])

  const push = useCallback((options: ToastOptions) => {
    setRecords((current) => {
      const next = [...current.filter((record) => !record.leaving), { ...options, id: nextId.current++, leaving: false }]
      return next.slice(-MAX_VISIBLE)
    })
  }, [])

  useEffect(() => {
    emit = push
    return () => {
      if (emit === push) emit = null
    }
  }, [push])

  const value = useRef({ toast: push }).current

  return (
    <ToastContext.Provider value={value}>
      <style href="ui-toast" precedence="default">{css}</style>
      {children}
      <div className="ui-toaster" aria-live="polite" aria-relevant="additions">
        {records.map((record) => (
          <ToastItem key={record.id} record={record} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}
