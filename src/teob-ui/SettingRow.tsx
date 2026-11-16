import type { ReactNode } from 'react'
import { cx } from './cx'

export interface SettingRowProps {
  label: ReactNode
  description?: ReactNode
  control: ReactNode
  /** The label in `--danger`, for a row that removes or disables something. */
  danger?: boolean
  /** The id of the control the label names. */
  htmlFor?: string
}

const css = `
@layer teob-ui {
.ui-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-group);
  min-width: 0;
  padding: 10px 0;
  border-top: 1px solid var(--line);
}
.ui-setting:first-child { border-top: 0; }
.ui-setting__main { flex: 1; min-width: 0; }
.ui-setting__label {
  display: block;
  font-size: var(--fs-13);
  font-weight: 500;
  line-height: 1.4;
  color: var(--text);
}
.ui-setting--danger .ui-setting__label { color: var(--danger); }
.ui-setting__description {
  margin-top: 2px;
  max-width: 52ch;
  font-size: var(--fs-12);
  line-height: 1.5;
  color: var(--text-muted);
}
.ui-setting__control {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  flex: none;
  min-width: 0;
}
@media (max-width: 720px) {
  .ui-setting {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-2);
  }
  .ui-setting__control { justify-content: flex-start; flex-wrap: wrap; }
}
}
`

/** One settings row: what it is on the left, the control on the right, a hairline above. */
export function SettingRow({ label, description, control, danger = false, htmlFor }: SettingRowProps) {
  return (
    <>
      <style href="ui-setting-row" precedence="default">{css}</style>
      <div className={cx('ui-setting', danger && 'ui-setting--danger')}>
        <div className="ui-setting__main">
          {htmlFor ? (
            <label className="ui-setting__label" htmlFor={htmlFor}>
              {label}
            </label>
          ) : (
            <span className="ui-setting__label">{label}</span>
          )}
          {description && <div className="ui-setting__description">{description}</div>}
        </div>
        <div className="ui-setting__control">{control}</div>
      </div>
    </>
  )
}
