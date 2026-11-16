import type { CSSProperties, SelectHTMLAttributes } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: [value: string, label: string][]
  style?: CSSProperties
}

const css = `
@layer teob-ui {
.ui-select-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: fit-content;
  max-width: 100%;
  height: 32px;
  padding-left: 10px;
  background: var(--bg-input);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  transition: border-color var(--dur-fast) var(--ease-standard), background-color var(--dur-fast) var(--ease-standard);
}
@media (hover: hover) {
  .ui-select-wrap:has(.ui-select:hover:not([disabled])) { border-color: var(--text-faint); }
}
.ui-select-wrap:has(.ui-select:focus-visible) { border-color: var(--accent); }
.ui-select-wrap:has(.ui-select[disabled]) { background: var(--bg-subtle); cursor: not-allowed; }
.ui-select {
  width: 100%;
  height: 100%;
  max-width: 100%;
  padding: 0 28px 0 0;
  font-family: inherit;
  font-size: var(--fs-12);
  line-height: 1.4;
  color: var(--text);
  background: transparent;
  border: 0;
  appearance: none;
  -webkit-appearance: none;
  text-overflow: ellipsis;
  cursor: pointer;
}
.ui-select:focus-visible { outline: none; }
.ui-select[disabled] { color: var(--text-faint); cursor: not-allowed; }
.ui-select-wrap__chevron {
  position: absolute;
  right: 8px;
  display: inline-flex;
  color: var(--text-muted);
  pointer-events: none;
}
.ui-select[disabled] ~ .ui-select-wrap__chevron { color: var(--text-faint); }
@media (prefers-reduced-motion: reduce) {
  .ui-select-wrap { transition: none; }
}
}
`

export function Select({ options, className, style, ...rest }: SelectProps) {
  return (
    <>
      <style href="ui-select" precedence="default">{css}</style>
      <span className="ui-select-wrap">
        <select {...rest} className={cx('ui-select', className)} style={style}>
          {options.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span className="ui-select-wrap__chevron" aria-hidden="true">
          <Icon name="chevronDown" size={16} />
        </span>
      </span>
    </>
  )
}
