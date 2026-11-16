import { useState } from 'react'
import { Button } from './Button'
import { Icon } from './Icon'
import { toast } from './Toast'
import { cx } from './cx'

export interface CodeBlockProps {
  code: string
  label?: string
  language?: string
  maxHeight?: number | string
  /** Show the Copy button; on by default. */
  copy?: boolean
  className?: string
}

const css = `
@layer teob-ui {
.ui-code {
  min-width: 0;
  overflow: hidden;
  background: var(--bg-subtle);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}
.ui-code__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: 34px;
  padding: 2px 4px 2px 10px;
  border-bottom: 1px solid var(--line);
}
.ui-code__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-12);
  color: var(--text-muted);
}
.ui-code__language {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--fs-11);
  color: var(--text-faint);
}
.ui-code__actions { display: flex; align-items: center; gap: 2px; flex: none; }
.ui-code__body {
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  overscroll-behavior: contain;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 1.55;
  color: var(--text-soft);
  white-space: pre;
  tab-size: 2;
}
.ui-code--wrap .ui-code__body { white-space: pre-wrap; overflow-wrap: anywhere; }
}
`

/** A read-only block of code or a command: a quiet well, a label, Copy and a wrap toggle. */
export function CodeBlock({ code, label, language, maxHeight, copy = true, className }: CodeBlockProps) {
  const [wrap, setWrap] = useState(false)
  const showHead = copy || !!label || !!language
  return (
    <>
      <style href="ui-code-block" precedence="default">{css}</style>
      <div className={cx('ui-code', wrap && 'ui-code--wrap', className)}>
        {showHead && (
          <div className="ui-code__head">
            <span className="ui-code__label">{label}</span>
            {language && <span className="ui-code__language">{language}</span>}
            <span className="ui-code__actions">
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={wrap}
                title={wrap ? 'Do not wrap long lines' : 'Wrap long lines'}
                onClick={() => setWrap((value) => !value)}
              >
                Wrap
              </Button>
              {copy && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Icon name="copy" size={16} />}
                  onClick={() => {
                    navigator.clipboard?.writeText(code)
                    toast({ title: 'Copied' })
                  }}
                >
                  Copy
                </Button>
              )}
            </span>
          </div>
        )}
        <pre className="ui-code__body" style={maxHeight === undefined ? undefined : { maxHeight }}>
          <code>{code}</code>
        </pre>
      </div>
    </>
  )
}
