import type { ReactNode } from 'react'
import { cx } from './cx'

export interface Crumb {
  label: string
  href?: string
}

export interface PageHeaderProps {
  breadcrumb: Crumb[]
  title: string
  badges?: ReactNode
  actions?: ReactNode
  description?: ReactNode
  /** Page tabs follow: their own line separates, so the header draws none. */
  tabsBelow?: boolean
  className?: string
}

const css = `
@layer teob-ui {
.ui-page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  min-height: 64px;
  padding: 6px 0 10px;
  margin-bottom: var(--gap-group);
}
.ui-page-header--tabs { margin-bottom: var(--gap-group); }
.ui-page-header__main { min-width: 0; }
.ui-page-header__crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 16px;
  font-size: var(--fs-12);
  color: var(--text-muted);
  overflow: hidden;
}
.ui-page-header__crumbs a { color: var(--text-muted); text-decoration: none; }
@media (hover: hover) {
  .ui-page-header__crumbs a:hover { color: var(--text); text-decoration: underline; }
}
.ui-page-header__crumb-item { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.ui-page-header__crumb { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-page-header__sep { color: var(--text-faint); }
.ui-page-header__title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.ui-page-header__title {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: var(--fs-20);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--text);
}
.ui-page-header__description { margin-top: 4px; font-size: var(--fs-12); color: var(--text-muted); overflow-wrap: anywhere; }
.ui-page-header__actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; flex: none; }
@media (max-width: 1024px) {
  .ui-page-header { align-items: flex-start; flex-wrap: wrap; }
  .ui-page-header__actions { width: 100%; justify-content: flex-start; }
}
}
`

export function PageHeader({ breadcrumb, title, badges, actions, description, tabsBelow = false, className }: PageHeaderProps) {
  return (
    <>
      <style href="ui-page-header" precedence="default">{css}</style>
      <header className={cx('ui-page-header', tabsBelow && 'ui-page-header--tabs', className)}>
        <div className="ui-page-header__main">
          <nav className="ui-page-header__crumbs" aria-label="Breadcrumb">
            {breadcrumb.map((crumb, index) => {
              const last = index === breadcrumb.length - 1
              return (
                <span key={`${crumb.label}-${index}`} className="ui-page-header__crumb-item">
                  {index > 0 && <span className="ui-page-header__sep" aria-hidden="true">/</span>}
                  {last || !crumb.href ? (
                    <span className="ui-page-header__crumb" aria-current={last ? 'page' : undefined}>
                      {crumb.label}
                    </span>
                  ) : (
                    <a className="ui-page-header__crumb" href={crumb.href}>
                      {crumb.label}
                    </a>
                  )}
                </span>
              )
            })}
          </nav>
          <div className="ui-page-header__title-row">
            <h1 className="ui-page-header__title">{title}</h1>
            {badges}
          </div>
          {description && <div className="ui-page-header__description">{description}</div>}
        </div>
        {actions && <div className="ui-page-header__actions">{actions}</div>}
      </header>
    </>
  )
}
