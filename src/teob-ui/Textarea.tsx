import type { CSSProperties, TextareaHTMLAttributes } from 'react'
import { cx } from './cx'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** `--danger` border and `aria-invalid`; the message is the caller's. */
  invalid?: boolean
  style?: CSSProperties
}

const css = `
@layer teob-ui {
.ui-textarea {
  width: 100%;
  min-height: 72px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: var(--fs-12);
  line-height: 1.5;
  color: var(--text);
  background: var(--bg-input);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  resize: vertical;
  transition: border-color var(--dur-fast) var(--ease-standard), background-color var(--dur-fast) var(--ease-standard);
}
.ui-textarea::placeholder { color: var(--text-faint); }
@media (hover: hover) {
  .ui-textarea:hover:not([disabled]) { border-color: var(--text-faint); }
}
.ui-textarea:focus-visible { border-color: var(--accent); }
.ui-textarea[aria-invalid='true'] { border-color: var(--danger); }
.ui-textarea[disabled] { color: var(--text-faint); background: var(--bg-subtle); cursor: not-allowed; }
@media (prefers-reduced-motion: reduce) {
  .ui-textarea { transition: none; }
}
}
`

export function Textarea({ invalid = false, className, style, rows = 3, ...rest }: TextareaProps) {
  return (
    <>
      <style href="ui-textarea" precedence="default">{css}</style>
      <textarea
        {...rest}
        rows={rows}
        className={cx('ui-textarea', className)}
        style={style}
        aria-invalid={invalid || undefined}
      />
    </>
  )
}
