import type { CSSProperties, ReactNode } from 'react'
import { Button } from './Button'
import { Icon } from './Icon'
import { m, motionEnter, motionExit } from './motion'
import { ScrollArea } from './ScrollArea'
import { cx } from './cx'

export interface DetailPanelProps {
  label: string
  header?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Default 400 px. */
  width?: number
  /** Below 1200 px it becomes a fixed overlay; the showcase turns that off to show it inline. */
  overlay?: boolean
  className?: string
}

const css = `
@layer teob-ui {
.ui-detail {
  position: sticky;
  top: var(--page-header-h, 0px);
  display: flex;
  flex-direction: column;
  width: 100%;
  --ui-detail-max: calc(100vh - 72px - var(--page-header-h, 0px));
  max-height: var(--ui-detail-max);
  min-height: 0;
  background: var(--surface-2);
  border-left: 1px solid var(--line);
}
.ui-detail__header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 6px 8px 6px 12px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--line);
}
.ui-detail__heading { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.ui-detail__label {
  flex: none;
  font-size: var(--fs-11);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.ui-detail__header-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-11);
  color: var(--text-soft);
}
.ui-detail__body { padding: 0 14px 16px; overscroll-behavior: contain; }
.ui-detail__footer { flex: none; padding: 10px 14px; border-top: 1px solid var(--line); }
@media (max-width: 1199px) {
  .ui-detail[data-overlay='true'] {
    position: fixed;
    top: 48px;
    right: 0;
    bottom: 0;
    width: min(400px, 100vw);
    --ui-detail-max: calc(100vh - 48px);
    max-height: none;
    z-index: 40;
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-md);
  }
}
}
`

export function DetailPanel({ label, header, onClose, children, footer, width = 400, overlay = true, className }: DetailPanelProps) {
  return (
    <>
      <style href="ui-detail-panel" precedence="default">{css}</style>
      <m.aside
        className={cx('ui-detail', className)}
        role="region"
        aria-label={label}
        data-overlay={overlay ? 'true' : undefined}
        style={{ maxWidth: width } as CSSProperties}
        initial={{ opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0, transition: motionEnter }}
        exit={{ opacity: 0, x: 8, transition: motionExit }}
      >
        <div className="ui-detail__header">
          <div className="ui-detail__heading">
            <span className="ui-detail__label">{label}</span>
            {header && <span className="ui-detail__header-text">{header}</span>}
          </div>
          <Button variant="ghost" size="sm" aria-label="Close" icon={<Icon name="close" size={16} />} onClick={onClose} />
        </div>
        <ScrollArea style={{ flex: 1, minHeight: 0 }} viewProps={{ className: 'ui-detail__body' }}>
          {children}
        </ScrollArea>
        {footer && <div className="ui-detail__footer">{footer}</div>}
      </m.aside>
    </>
  )
}
