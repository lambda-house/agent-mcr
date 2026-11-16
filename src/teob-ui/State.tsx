import type { ReactNode } from 'react'
import { Button } from './Button'
import { Icon, type IconName } from './Icon'
import { Skeleton } from './Skeleton'
import { errorText } from './errorText'

export interface EmptyStateProps {
  title: string
  children?: ReactNode
  action?: ReactNode
  icon?: IconName
}

export interface ErrorStateProps {
  error: unknown
  onRetry?: () => void
  title?: string
  children?: ReactNode
}

export interface NoAccessStateProps {
  title?: string
  children?: ReactNode
  action?: ReactNode
  icon?: IconName
}

export interface LoadingRowsProps {
  rows?: number
  columns?: number
  height?: number
}

const css = `
@layer teob-ui {
.ui-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 8px;
  max-width: 420px;
  margin: 0 auto;
  padding: 24px 16px;
}
.ui-state__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin-bottom: 2px;
  color: var(--text-muted);
  background: var(--bg-subtle);
  border: 1px solid var(--line);
  border-radius: var(--r-full);
}
.ui-state--error .ui-state__icon { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-line); }
.ui-state--locked .ui-state__icon { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-line); }
.ui-state__title { font-size: var(--fs-14); font-weight: 600; color: var(--text); }
.ui-state__text { font-size: var(--fs-13); color: var(--text-soft); line-height: 1.5; }
.ui-state__detail { font-family: var(--font-mono); font-size: var(--fs-11); color: var(--text-muted); word-break: break-word; }
.ui-state__actions { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 4px; }
.ui-loading-rows { display: grid; gap: 10px; width: 100%; padding: 4px 0; }
.ui-loading-rows__row { display: grid; gap: 12px; align-items: center; }
}
`

function Frame({
  tone,
  icon,
  title,
  children,
  action,
  text,
}: {
  tone: 'empty' | 'error' | 'locked'
  icon: IconName
  title: string
  children?: ReactNode
  action?: ReactNode
  text?: ReactNode
}) {
  return (
    <>
      <style href="ui-state" precedence="default">{css}</style>
      <div className={`ui-state ui-state--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
        <span className="ui-state__icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
        <div className="ui-state__title">{title}</div>
        {(children || text) && <div className="ui-state__text">{children ?? text}</div>}
        {action && <div className="ui-state__actions">{action}</div>}
      </div>
    </>
  )
}

/** The inline "nothing here" line: one muted sentence where a list, table or section is empty (a whole empty page or table
 *  uses `EmptyState`). */
export function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <>
      <style href="ui-empty-line" precedence="default">{`.ui-empty-line { display: block; font-size: var(--fs-13); line-height: 1.5; color: var(--text-muted); }`}</style>
      <span className="ui-empty-line">{children}</span>
    </>
  )
}

/** Nothing here yet: what this is, one sentence, one action. */
export function EmptyState({ title, children, action, icon = 'memories' }: EmptyStateProps) {
  return (
    <Frame tone="empty" icon={icon} title={title} action={action}>
      {children}
    </Frame>
  )
}

/** Something failed: what failed, the reason, and Retry. */
export function ErrorState({ error, onRetry, title = 'Something went wrong', children }: ErrorStateProps) {
  const message = error ? errorText(error) : null
  return (
    <Frame
      tone="error"
      icon="alert"
      title={title}
      action={
        onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      {children ?? (message ? <span className="ui-state__detail">{message}</span> : 'This page could not be loaded.')}
    </Frame>
  )
}

/** Permission is missing: say what is missing and who can grant it. */
export function NoAccessState({ title = 'You do not have access', children, action, icon = 'lock' }: NoAccessStateProps) {
  return (
    <Frame tone="locked" icon={icon} title={title} action={action}>
      {children ?? 'Ask an owner of the organisation to grant you access.'}
    </Frame>
  )
}

/** Loading rows matching the real row height, so the page does not shift when the data lands. */
export function LoadingRows({ rows = 5, columns = 4, height = 24 }: LoadingRowsProps) {
  return (
    <>
      <style href="ui-state" precedence="default">{css}</style>
      <div className="ui-loading-rows" role="status" aria-busy="true" aria-label="Loading">
        {Array.from({ length: rows }, (_, row) => (
          <div
            key={row}
            className="ui-loading-rows__row"
            style={{ gridTemplateColumns: Array.from({ length: columns }, (_, column) => (column === 0 ? '2fr' : '1fr')).join(' ') }}
          >
            {Array.from({ length: columns }, (_, column) => (
              <Skeleton key={column} height={height} radius="var(--r-xs)" />
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
