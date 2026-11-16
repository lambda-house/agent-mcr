import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { cx } from './cx'

export type NoticeTone = 'info' | 'warn' | 'danger' | 'ok'

export interface NoticeProps {
  tone?: NoticeTone
  title: ReactNode
  children: ReactNode
  action?: ReactNode
  className?: string
}

const css = `
@layer teob-ui {
.ui-notice {
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--layer-2, var(--bg-subtle));
  color: var(--text-soft);
  font-size: var(--fs-13);
  line-height: 1.5;
}
.ui-notice__head { display: flex; align-items: center; gap: 8px; }
.ui-notice__icon { display: inline-flex; flex: none; color: var(--text-muted); }
.ui-notice__title { flex: 1; min-width: 0; font-size: var(--fs-13); font-weight: 600; color: var(--text); }
.ui-notice__actions { display: flex; align-items: center; gap: 8px; flex: none; }
.ui-notice__body { margin-top: 6px; padding-left: 24px; }
.ui-notice--info { background: var(--info-bg); border-color: var(--info-line); }
.ui-notice--info .ui-notice__icon { color: var(--info); }
.ui-notice--warn { background: var(--warn-bg); border-color: var(--warn-line); }
.ui-notice--warn .ui-notice__icon { color: var(--warn); }
.ui-notice--danger { background: var(--danger-bg); border-color: var(--danger-line); }
.ui-notice--danger .ui-notice__icon { color: var(--danger); }
.ui-notice--ok { background: var(--ok-bg); border-color: var(--ok-line); }
.ui-notice--ok .ui-notice__icon { color: var(--ok); }
}
`

const icons: Record<NoticeTone, IconName> = {
  info: 'info',
  warn: 'alert',
  danger: 'alert',
  ok: 'check',
}

export function Notice({ tone = 'info', title, children, action, className }: NoticeProps) {
  return (
    <>
      <style href="ui-notice" precedence="default">{css}</style>
      <div className={cx('ui-notice', `ui-notice--${tone}`, className)} role="note">
        <div className="ui-notice__head">
          <span className="ui-notice__icon" aria-hidden="true">
            <Icon name={icons[tone]} size={16} />
          </span>
          <div className="ui-notice__title">{title}</div>
          {action && <div className="ui-notice__actions">{action}</div>}
        </div>
        <div className="ui-notice__body">{children}</div>
      </div>
    </>
  )
}
