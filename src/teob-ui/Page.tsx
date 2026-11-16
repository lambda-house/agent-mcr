import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { cx } from './cx'
import type { Crumb } from './PageHeader'

export interface PageProps {
  /** The page's name: the `h1`, shown last in the location line. */
  title: string
  /** Where the page sits, outermost first (the title is added after them). */
  breadcrumb?: Crumb[]
  /** Status chips beside the title. */
  badges?: ReactNode
  /** A small muted line under the location (an address, a count). */
  description?: ReactNode
  /** View tabs (a `Tabs` with `variant="underline"`): they sit in row 1 and take its height. */
  tabs?: ReactNode
  /** Page actions, right-aligned in row 1. */
  actions?: ReactNode
  /** Row 2, left: filters and search. Row 2 exists only when this or `display` is given. */
  toolbar?: ReactNode
  /** Row 2, right: the "Display" menu (view options). */
  display?: ReactNode
  /** `default` 1200 px, `narrow` the reading width (`--content-max`), `full` no limit. */
  width?: 'default' | 'narrow' | 'full'
  className?: string
  children: ReactNode
}

const css = `
@layer teob-ui {
.ui-page { --page-pad: var(--sp-5); min-width: 0; }
.ui-page__header { position: sticky; top: 0; z-index: 4; background: var(--surface-1); }
.ui-page__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  column-gap: var(--sp-3);
  padding: 0 var(--page-pad);
  border-bottom: 1px solid var(--line);
}
.ui-page__row--main { min-height: 48px; }
.ui-page__row--tools { min-height: 40px; justify-content: space-between; row-gap: 4px; padding-top: 4px; padding-bottom: 4px; }
.ui-page__tools-left, .ui-page__tools-right { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; min-width: 0; }
.ui-page__location { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 6px 0; }
.ui-page__trail { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--fs-13); }
.ui-page__crumb { color: var(--text-muted); text-decoration: none; white-space: nowrap; }
@media (hover: hover) { a.ui-page__crumb:hover { color: var(--text); text-decoration: underline; } }
.ui-page__sep { color: var(--text-faint); }
.ui-page__title { margin: 0; min-width: 0; font-size: var(--fs-14); font-weight: 600; letter-spacing: -0.005em; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-page__description { margin-top: 1px; font-size: var(--fs-11); color: var(--text-muted); overflow-wrap: anywhere; }
.ui-page__tabs { align-self: stretch; display: flex; min-height: 40px; min-width: 0; flex: 1 1 auto; }
.ui-page__tabs .ui-tabs { margin: 0; border: 0; }
.ui-page__tabs .ui-tabs__tab { height: auto; }
.ui-page__actions { display: flex; align-items: center; gap: var(--sp-2); margin-left: auto; padding: 6px 0; flex-wrap: wrap; }
.ui-page__body { padding: var(--page-pad); }
.ui-page__content { margin: 0 auto; max-width: 1200px; min-width: 0; }
.ui-page__content--narrow { max-width: var(--content-max); margin-left: 0; }
.ui-page__content--full { max-width: none; }
@media (max-width: 720px) { .ui-page { --page-pad: var(--sp-3); } }
}
`

/** The page template: a sticky two-row header (row 1: location, view tabs, actions; row 2, when given: filters left and
 *  "Display" right), then the content in the standard padding and width. Screens put their header content here and
 *  stop assembling headers by hand. The header's height is published as `--page-header-h` for sticky neighbours. */
export function Page({ title, breadcrumb = [], badges, description, tabs, actions, toolbar, display, width = 'default', className, children }: PageProps) {
  const root = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = header.current
    const host = root.current
    if (!el || !host) return
    const set = () => host.style.setProperty('--page-header-h', `${el.offsetHeight}px`)
    set()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(set)
    observer?.observe(el)
    return () => observer?.disconnect()
  }, [])
  return (
    <>
      <style href="ui-page" precedence="default">{css}</style>
      <div ref={root} className={cx('ui-page', className)}>
        <header ref={header} className="ui-page__header">
          <div className="ui-page__row ui-page__row--main">
            <div className="ui-page__location">
              <nav className="ui-page__trail" aria-label="Breadcrumb">
                {breadcrumb.map((crumb, index) => (
                  <span key={`${crumb.label}-${index}`} style={{ display: 'contents' }}>
                    {crumb.href ? (
                      <a className="ui-page__crumb" href={crumb.href}>
                        {crumb.label}
                      </a>
                    ) : (
                      <span className="ui-page__crumb">{crumb.label}</span>
                    )}
                    <span className="ui-page__sep" aria-hidden="true">
                      /
                    </span>
                  </span>
                ))}
                <h1 className="ui-page__title">{title}</h1>
                {badges}
              </nav>
              {description && <div className="ui-page__description">{description}</div>}
            </div>
            {tabs && <div className="ui-page__tabs">{tabs}</div>}
            {actions && <div className="ui-page__actions">{actions}</div>}
          </div>
          {(toolbar || display) && (
            <div className="ui-page__row ui-page__row--tools">
              <div className="ui-page__tools-left">{toolbar}</div>
              <div className="ui-page__tools-right">{display}</div>
            </div>
          )}
        </header>
        <div className="ui-page__body">
          <div className={cx('ui-page__content', width !== 'default' && `ui-page__content--${width}`)}>{children}</div>
        </div>
      </div>
    </>
  )
}
