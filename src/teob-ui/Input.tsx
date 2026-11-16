import type { InputHTMLAttributes, CSSProperties } from 'react'
import { Icon } from './Icon'
import { cx } from './cx'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** `--danger` border and `aria-invalid`; the message is the caller's. */
  invalid?: boolean
  /** 32 px (`sm`, default) or 36 px (`md`). */
  inputSize?: 'sm' | 'md'
  style?: CSSProperties
  /** A search field's clear button: shown while there is a value, it calls this (the caller empties the value). */
  onClear?: () => void
  /** The clear button's accessible name; "Clear" by default. */
  clearLabel?: string
}

const css = `
@layer teob-ui {
.ui-input {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  font-family: inherit;
  font-size: var(--fs-12);
  line-height: 1.4;
  color: var(--text);
  background: var(--bg-input);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  transition: border-color var(--dur-fast) var(--ease-standard), background-color var(--dur-fast) var(--ease-standard);
}
.ui-input--md { height: 36px; }
.ui-input::placeholder { color: var(--text-faint); }
@media (hover: hover) {
  .ui-input:hover:not([disabled]) { border-color: var(--text-faint); }
}
.ui-input:focus-visible { border-color: var(--accent); }
.ui-input[aria-invalid='true'] { border-color: var(--danger); }
.ui-input[aria-invalid='true']:focus-visible { border-color: var(--danger); }
.ui-input[disabled] { color: var(--text-faint); background: var(--bg-subtle); cursor: not-allowed; }
.ui-input-clearable { position: relative; display: flex; width: 100%; min-width: 0; }
.ui-input-clearable .ui-input { padding-right: 28px; }
.ui-input__clear {
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--text-muted);
  background: none;
  border: 0;
  border-radius: var(--r-xs);
  cursor: pointer;
}
@media (hover: hover) {
  .ui-input__clear:hover { color: var(--text); background: var(--bg-hover); }
}
@media (prefers-reduced-motion: reduce) {
  .ui-input { transition: none; }
}
}
`

export function Input({ invalid = false, inputSize = 'sm', className, style, onClear, clearLabel = 'Clear', ...rest }: InputProps) {
  const input = (
    <input
      {...rest}
      className={cx('ui-input', inputSize === 'md' && 'ui-input--md', className)}
      style={style}
      aria-invalid={invalid || undefined}
    />
  )
  return (
    <>
      <style href="ui-input" precedence="default">{css}</style>
      {onClear ? (
        <span className="ui-input-clearable">
          {input}
          {rest.value !== undefined && rest.value !== '' && (
            <button type="button" className="ui-input__clear" aria-label={clearLabel} onClick={onClear}>
              <Icon name="close" size={16} />
            </button>
          )}
        </span>
      ) : (
        input
      )}
    </>
  )
}
