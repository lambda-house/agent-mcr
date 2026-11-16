import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children?: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and ignores clicks, without leaving the tab order (`aria-busy`, never `disabled`). */
  loading?: boolean
  icon?: ReactNode
  iconRight?: ReactNode
}

const css = `
@layer teob-ui {
.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  font-family: inherit;
  font-size: var(--fs-12);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  cursor: pointer;
  user-select: none;
  transition: background-color var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard), transform var(--dur-fast) var(--ease-standard);
}
.ui-btn:active:not([aria-busy='true']) { transform: scale(0.97); }
.ui-btn[disabled], .ui-btn[aria-disabled='true'] { opacity: 0.55; cursor: default; }
.ui-btn[aria-busy='true'] { cursor: progress; }
.ui-btn--sm { height: 28px; padding: 0 10px; }
.ui-btn--md { height: 32px; padding: 0 12px; }
.ui-btn--lg { height: 36px; padding: 0 14px; font-size: var(--fs-13); }
.ui-btn--icon.ui-btn--sm { width: 28px; padding: 0; }
.ui-btn--icon.ui-btn--md { width: 32px; padding: 0; }
.ui-btn--icon.ui-btn--lg { width: 36px; padding: 0; }
.ui-btn--primary { background: var(--text); border-color: var(--text); color: var(--text-inverse); }
.ui-btn--secondary { background: var(--bg-panel); border-color: var(--line-strong); color: var(--text); }
.ui-btn--ghost { background: transparent; border-color: transparent; color: var(--text-soft); }
.ui-btn--destructive { background: var(--danger-bg); border-color: var(--danger-line); color: var(--danger); }
@media (hover: hover) {
  .ui-btn--primary:hover:not([disabled]):not([aria-busy='true']) {
    background: color-mix(in srgb, var(--text) 88%, var(--bg-panel));
    border-color: color-mix(in srgb, var(--text) 88%, var(--bg-panel));
  }
  .ui-btn--secondary:hover:not([disabled]):not([aria-busy='true']) { background: var(--bg-hover); }
  .ui-btn--ghost:hover:not([disabled]):not([aria-busy='true']) { background: var(--bg-hover); color: var(--text); }
  .ui-btn--destructive:hover:not([disabled]):not([aria-busy='true']) {
    background: color-mix(in srgb, var(--danger-bg) 88%, var(--danger));
    border-color: var(--danger-line);
  }
}
.ui-btn__icon { display: inline-flex; align-items: center; }
.ui-btn__spinner {
  width: 12px;
  height: 12px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: var(--r-full);
  animation: ui-btn-spin 700ms linear infinite;
}
@keyframes ui-btn-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .ui-btn { transition: none; }
  .ui-btn:active:not([aria-busy='true']) { transform: none; }
  .ui-btn__spinner { animation: none; border-right-color: currentColor; opacity: 0.5; }
}
}
`

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  className,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconOnly = children === undefined || children === null || children === false
  return (
    <>
      <style href="ui-button" precedence="default">{css}</style>
      <button
        {...rest}
        type={type}
        className={cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, iconOnly && 'ui-btn--icon', className)}
        aria-busy={loading || undefined}
        onClick={(event) => {
          if (loading) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          onClick?.(event)
        }}
      >
        {loading ? (
          <span className="ui-btn__spinner" aria-hidden="true" />
        ) : (
          icon && <span className="ui-btn__icon" aria-hidden="true">{icon}</span>
        )}
        {children}
        {!loading && iconRight && <span className="ui-btn__icon" aria-hidden="true">{iconRight}</span>}
      </button>
    </>
  )
}
