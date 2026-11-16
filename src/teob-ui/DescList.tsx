import type { ReactNode } from 'react'
import { cx } from './cx'

export interface DescListItem {
  label: string
  value: ReactNode
  mono?: boolean
}

export interface DescListProps {
  items: DescListItem[]
  className?: string
}

const css = `
@layer teob-ui {
.ui-desc-list {
  display: grid;
  grid-template-columns: minmax(88px, max-content) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  font-size: var(--fs-13);
  line-height: 1.45;
}
.ui-desc-list__label { color: var(--text-muted); font-size: var(--fs-12); }
.ui-desc-list__value { margin: 0; min-width: 0; color: var(--text-soft); overflow-wrap: anywhere; }
.ui-desc-list__value--mono { font-family: var(--font-mono); font-size: var(--fs-11); }
}
`

export function DescList({ items, className }: DescListProps) {
  return (
    <>
      <style href="ui-desc-list" precedence="default">{css}</style>
      <dl className={cx('ui-desc-list', className)}>
        {items.map((item) => (
          <div key={item.label} style={{ display: 'contents' }}>
            <dt className="ui-desc-list__label">{item.label}</dt>
            <dd className={cx('ui-desc-list__value', item.mono && 'ui-desc-list__value--mono')}>{item.value}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}
