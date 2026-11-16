import { useId, type ReactNode } from 'react'
import { cx } from './cx'

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  disabled?: boolean
  description?: ReactNode
  className?: string
}

const css = `
@layer teob-ui {
.ui-checkbox {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 28px;
  padding: 2px 0;
  cursor: pointer;
}
.ui-checkbox[data-disabled='true'] { cursor: default; opacity: 0.6; }
.ui-checkbox input[type='checkbox'] {
  appearance: none;
  -webkit-appearance: none;
  display: inline-grid;
  place-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  margin: 1px 0 0;
  background: var(--bg-input);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-xs);
  cursor: pointer;
}
.ui-checkbox input[type='checkbox']:checked { background: var(--accent); border-color: var(--accent); }
.ui-checkbox input[type='checkbox']:checked::after {
  content: '';
  width: 8px;
  height: 4px;
  border-left: 2px solid var(--text-inverse);
  border-bottom: 2px solid var(--text-inverse);
  transform: translateY(-1px) rotate(-45deg);
}
.ui-checkbox input[type='checkbox']:disabled { cursor: default; }
.ui-checkbox__text { min-width: 0; }
.ui-checkbox__label { display: block; font-size: var(--fs-13); line-height: 1.35; color: var(--text); }
.ui-checkbox__description { display: block; margin-top: 1px; font-size: var(--fs-12); line-height: 1.4; color: var(--text-muted); }
@media (prefers-reduced-motion: reduce) {
  .ui-checkbox input[type='checkbox'] { transition: none; }
}
}
`

export function Checkbox({ checked, onChange, label, disabled = false, description, className }: CheckboxProps) {
  const id = useId()
  const descriptionId = `${id}-description`
  return (
    <>
      <style href="ui-checkbox" precedence="default">{css}</style>
      <label className={cx('ui-checkbox', className)} data-disabled={disabled ? 'true' : undefined}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={description ? descriptionId : undefined}
        />
        <span className="ui-checkbox__text">
          <span className="ui-checkbox__label">{label}</span>
          {description && (
            <span className="ui-checkbox__description" id={descriptionId}>
              {description}
            </span>
          )}
        </span>
      </label>
    </>
  )
}
