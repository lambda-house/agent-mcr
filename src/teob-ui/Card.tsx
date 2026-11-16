import type { CSSProperties, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { cx } from './cx'

export interface CardProps {
  href?: string
  children: ReactNode
  className?: string
  /** Inner padding; 16 px by default. */
  padding?: number | string
  /** `bordered` (default), `muted` (a tinted surface, for notes) or `plain` (no frame: the card's zones only). */
  variant?: 'bordered' | 'muted' | 'plain'
  style?: CSSProperties
}

const css = `
@layer teob-ui {
.ui-card {
  --card-pad: 16px;
  display: block;
  min-width: 0;
  padding: var(--card-pad);
  background: var(--layer-1);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  color: var(--text);
}
.ui-card--muted { background: var(--layer-2); }
.ui-card--plain { background: none; border-color: transparent; }
.ui-card--link { text-decoration: none; transition: background-color var(--dur-fast) var(--ease-standard); }
@media (hover: hover) {
  .ui-card--link:hover { background: var(--bg-hover); text-decoration: none; }
}
.ui-card--zoned { padding: 0; }
.ui-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--gap-group);
  flex-wrap: wrap;
  padding: 14px var(--card-pad);
  border-bottom: 1px solid var(--line);
}
.ui-card__heading { display: flex; align-items: flex-start; gap: var(--gap-tight); min-width: 0; }
.ui-card__icon { display: inline-flex; flex: none; margin-top: 1px; color: var(--text-muted); }
.ui-card__title { margin: 0; font-size: var(--fs-14); font-weight: 600; letter-spacing: -0.005em; line-height: 1.4; color: var(--text); }
.ui-card__description { margin-top: 2px; font-size: var(--fs-12); line-height: 1.5; color: var(--text-muted); }
.ui-card__action { display: flex; align-items: center; gap: var(--gap-tight); flex-wrap: wrap; margin-inline-start: auto; }
.ui-card__content { min-width: 0; padding: var(--card-pad); }
/* a table that is the whole content runs to the card's edges; one among other content keeps the card's margins */
.ui-card__content:has(> .ui-table-wrap:only-child) { padding: 0; }
.ui-card__content > .ui-table-wrap { border: 0; border-radius: 0; background: none; }
.ui-card__content:not(:has(> .ui-table-wrap:only-child)) > .ui-table-wrap { margin-inline: calc(-1 * var(--card-pad)); width: auto; }
/* the form's actions at the card's end are its footer zone */
.ui-card__content > .ui-form-actions:last-child {
  margin: var(--gap-group) calc(-1 * var(--card-pad)) calc(-1 * var(--card-pad));
  padding: 12px var(--card-pad);
}

.ui-card__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--gap-tight) var(--gap-group);
  flex-wrap: wrap;
  padding: 12px var(--card-pad);
  border-top: 1px solid var(--line);
}
@media (prefers-reduced-motion: reduce) {
  .ui-card--link { transition: none; }
}
}
`

/** A framed group. Bare, it is a padded box; with `CardHeader`, `CardContent` and `CardFooter` it has zones: a title
 *  left and an action right, the content, and the actions that end it. Never nest one card in another. */
export function Card({ href, children, className, padding = 16, variant = 'bordered', style }: CardProps) {
  const root = <style href="ui-card" precedence="default">{css}</style>
  const cls = cx('ui-card', variant !== 'bordered' && `ui-card--${variant}`, className)
  if (href) {
    return (
      <>
        {root}
        <a href={href} className={cx(cls, 'ui-card--link')} style={{ padding, ...style }}>
          {children}
        </a>
      </>
    )
  }
  return (
    <>
      {root}
      <div className={cls} style={{ padding, ...style }}>
        {children}
      </div>
    </>
  )
}

export interface CardHeaderProps {
  title: ReactNode
  description?: ReactNode
  icon?: IconName
  /** Right-aligned: a button, a menu, a toolbar, a count. */
  action?: ReactNode
}

export function CardHeader({ title, description, icon, action }: CardHeaderProps) {
  return (
    <div className="ui-card__header">
      <div className="ui-card__heading">
        {icon && (
          <span className="ui-card__icon" aria-hidden="true">
            <Icon name={icon} size={16} />
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <h2 className="ui-card__title">{title}</h2>
          {description && <div className="ui-card__description">{description}</div>}
        </div>
      </div>
      {action && <div className="ui-card__action">{action}</div>}
    </div>
  )
}

export function CardContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('ui-card__content', className)}>{children}</div>
}

export function CardFooter({ children }: { children: ReactNode }) {
  return <div className="ui-card__footer">{children}</div>
}

/** A card with zones, as one element: header, content, optional footer. */
export function ZonedCard({
  className,
  header,
  footer,
  children,
}: {
  className?: string
  header: CardHeaderProps
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <Card className={cx('ui-card--zoned', className)} padding={0}>
      <CardHeader {...header} />
      <CardContent>{children}</CardContent>
      {footer && <CardFooter>{footer}</CardFooter>}
    </Card>
  )
}
