import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { Progress } from './Progress'
import { cx } from './cx'

export interface ChecklistItem {
  key: string
  label: ReactNode
  description?: ReactNode
  done: boolean
  current?: boolean
  href?: string
}

export interface ChecklistProps {
  title?: ReactNode
  description?: ReactNode
  done: number
  total: number
  items: ChecklistItem[]
  action?: ReactNode
  className?: string
}

const css = `
@layer teob-ui {
.ui-checklist { min-width: 0; }
.ui-checklist__head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.ui-checklist__title { font-size: var(--fs-14); font-weight: 600; color: var(--text); }
.ui-checklist__description { font-size: var(--fs-12); color: var(--text-muted); }
.ui-checklist__items { display: grid; margin-top: 8px; }
.ui-checklist__row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 40px;
  padding: 6px 8px;
  color: var(--text);
  text-decoration: none;
  border-radius: var(--r-sm);
}
.ui-checklist__row[data-current='true'] { background: var(--accent-bg); }
.ui-checklist__row[data-todo='true'] { color: var(--text-soft); }
@media (hover: hover) {
  .ui-checklist__row[href]:hover { background: var(--bg-hover); text-decoration: none; }
  .ui-checklist__row[data-current='true'][href]:hover { background: var(--accent-bg); }
}
.ui-checklist__mark { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none; margin-top: 1px; color: var(--ok); }
.ui-checklist__dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--text-faint); }
.ui-checklist__dot--current { background: var(--accent); }
.ui-checklist__dot--todo { background: transparent; border: 1px solid var(--line-strong); }
.ui-checklist__text { min-width: 0; flex: 1; }
.ui-checklist__label { display: block; font-size: var(--fs-13); font-weight: 500; }
.ui-checklist__row[data-done='true'] .ui-checklist__label { color: var(--text-muted); text-decoration: line-through; }
.ui-checklist__item-description { display: block; margin-top: 1px; font-size: var(--fs-12); color: var(--text-muted); }
.ui-checklist__action { display: flex; justify-content: flex-end; margin-top: 10px; }
}
`

export function Checklist({ title, description, done, total, items, action, className }: ChecklistProps) {
  const ratio = total > 0 ? done / total : 0
  return (
    <>
      <style href="ui-checklist" precedence="default">{css}</style>
      <div className={cx('ui-checklist', className)}>
        {(title || description) && (
          <div className="ui-checklist__head">
            {title && <span className="ui-checklist__title">{title}</span>}
            {description && <span className="ui-checklist__description">{description}</span>}
          </div>
        )}
        <Progress value={ratio} tone={done >= total ? 'ok' : 'accent'} label={`${done} of ${total} steps done`} />
        <div className="ui-checklist__items">
          {items.map((item) => {
            const content = (
              <>
                <span className="ui-checklist__mark" aria-hidden="true">
                  {item.done ? (
                    <Icon name="check" size={16} />
                  ) : (
                    <span
                      className={cx(
                        'ui-checklist__dot',
                        item.current && 'ui-checklist__dot--current',
                        !item.current && 'ui-checklist__dot--todo'
                      )}
                    />
                  )}
                </span>
                <span className="ui-checklist__text">
                  <span className="ui-checklist__label">{item.label}</span>
                  {item.description && <span className="ui-checklist__item-description">{item.description}</span>}
                </span>
              </>
            )
            const data = {
              'data-done': item.done ? 'true' : undefined,
              'data-current': item.current ? 'true' : undefined,
              'data-todo': !item.done && !item.current ? 'true' : undefined,
            }
            return item.href ? (
              <a key={item.key} href={item.href} className="ui-checklist__row" {...data}>
                {content}
              </a>
            ) : (
              <div key={item.key} className="ui-checklist__row" {...data}>
                {content}
              </div>
            )
          })}
        </div>
        {action && <div className="ui-checklist__action">{action}</div>}
      </div>
    </>
  )
}
