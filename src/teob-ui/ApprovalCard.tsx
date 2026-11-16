import type { ReactNode } from 'react'
import { Badge, type BadgeTone } from './Badge'
import { Button, type ButtonVariant } from './Button'
import { Card } from './Card'
import { Kbd } from './Kbd'
import { cx } from './cx'

export type ApprovalRisk = 'low' | 'medium' | 'high'

export interface ApprovalAction {
  label: ReactNode
  onSelect: () => void
  /** `primary` on the first action unless a variant is given. */
  variant?: ButtonVariant
  icon?: ReactNode
  shortcut?: string
}

export interface ApprovalCardProps {
  title: ReactNode
  risk: ApprovalRisk
  meta?: ReactNode
  summary?: ReactNode
  children?: ReactNode
  actions: ApprovalAction[]
  /** A decision is being written: every action is disabled. */
  busy?: boolean
  className?: string
}

const riskTone: Record<ApprovalRisk, BadgeTone> = {
  low: 'ok',
  medium: 'warn',
  high: 'danger',
}

const riskWords: Record<ApprovalRisk, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
}

const css = `
@layer teob-ui {
.ui-approval { padding: 0; overflow: hidden; }
.ui-approval__main { padding: 14px 16px; }
.ui-approval__head { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.ui-approval__head-text { flex: 1; min-width: 0; }
.ui-approval__title { font-size: var(--fs-14); font-weight: 600; line-height: 1.4; color: var(--text); overflow-wrap: anywhere; }
.ui-approval__meta { margin-top: 2px; font-size: var(--fs-12); color: var(--text-muted); overflow-wrap: anywhere; }
.ui-approval__summary { margin-top: 10px; font-size: var(--fs-13); color: var(--text-soft); line-height: 1.5; }
.ui-approval__body { margin-top: 10px; min-width: 0; }
.ui-approval__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding: 10px 16px;
  background: var(--bg-subtle);
  border-top: 1px solid var(--line);
}
@media (prefers-reduced-motion: reduce) {
  .ui-approval { transition: none; }
}
}
`

export function ApprovalCard({
  title,
  risk,
  meta,
  summary,
  children,
  actions,
  busy = false,
  className,
}: ApprovalCardProps) {
  return (
    <>
      <style href="ui-approval-card" precedence="default">{css}</style>
      <Card padding={0} className={cx('ui-approval', className)}>
        <div className="ui-approval__main">
          <div className="ui-approval__head">
            <Badge tone={riskTone[risk]}>{riskWords[risk]}</Badge>
            <div className="ui-approval__head-text">
              <div className="ui-approval__title">{title}</div>
              {meta && <div className="ui-approval__meta">{meta}</div>}
            </div>
          </div>
          {summary && <div className="ui-approval__summary">{summary}</div>}
          {children && <div className="ui-approval__body">{children}</div>}
        </div>
        {actions.length > 0 && (
          <div className="ui-approval__foot">
            {actions.map((action, index) => (
              <Button
                key={`${index}-${typeof action.label === 'string' ? action.label : 'action'}`}
                variant={action.variant ?? (index === 0 ? 'primary' : 'secondary')}
                size="sm"
                icon={action.icon}
                disabled={busy}
                onClick={action.onSelect}
              >
                {action.label}
                {action.shortcut && <Kbd>{action.shortcut}</Kbd>}
              </Button>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
