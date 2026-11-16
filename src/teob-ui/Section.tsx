import type { ReactNode } from 'react'
import { ZonedCard } from './Card'
import type { IconName } from './Icon'
import { cx } from './cx'

export interface SectionProps {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned in the header. */
  actions?: ReactNode
  icon?: IconName
  /** The card's footer zone: the actions that end it. */
  footer?: ReactNode
  children: ReactNode
  className?: string
}

/** A group of a page as a card: header (title, one-line description, actions), content, optional footer. The groups of
 *  a page sit `--gap-section` apart. */
export function Section({ title, description, actions, icon, footer, children, className }: SectionProps) {
  return (
    <ZonedCard className={cx('ui-section', className)} header={{ title, description, icon, action: actions }} footer={footer}>
      {children}
    </ZonedCard>
  )
}
