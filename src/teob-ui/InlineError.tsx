import { errorText } from './errorText'

const css = `
@layer teob-ui {
.ui-inline-error { margin: 6px 0; font-size: var(--fs-12); line-height: 1.4; color: var(--danger); overflow-wrap: anywhere; }
.ui-inline-error--inline { display: inline; margin: 0; }
}
`

/** A failed action, as one quiet line under what was attempted; nothing when there is no error. */
export function InlineError({ error, inline }: { error: unknown; inline?: boolean }) {
  if (!error) return null
  const Tag = inline ? 'span' : 'div'
  return (
    <>
      <style href="ui-inline-error" precedence="default">{css}</style>
      <Tag className={inline ? 'ui-inline-error ui-inline-error--inline' : 'ui-inline-error'} role="alert">
        {errorText(error)}
      </Tag>
    </>
  )
}
