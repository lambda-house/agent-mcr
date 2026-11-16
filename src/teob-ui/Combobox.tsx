import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { cx } from './cx'

export interface ComboboxOption {
  value: string
  label: string
  group?: string
  hint?: string
}

export interface ComboboxProps<V extends string | string[] = string> {
  options: ComboboxOption[]
  value: V
  onChange: (value: V) => void
  multiple?: boolean
  creatable?: boolean
  placeholder?: string
  'aria-label'?: string
  disabled?: boolean
  width?: number | string
  className?: string
  id?: string
}

const css = `
@layer teob-ui {
.ui-combobox { position: relative; display: inline-flex; flex-direction: column; min-width: 0; }
.ui-combobox__control {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 32px;
  padding: 0 8px;
  background: var(--bg-input);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  transition: border-color var(--dur-fast) var(--ease-standard);
}
.ui-combobox[data-open='true'] .ui-combobox__control { border-color: var(--accent); }
.ui-combobox__input {
  flex: 1;
  min-width: 48px;
  height: 30px;
  padding: 0;
  font-family: inherit;
  font-size: var(--fs-12);
  color: var(--text);
  background: transparent;
  border: 0;
  outline: none;
}
.ui-combobox__input::placeholder { color: var(--text-faint); }
.ui-combobox__input:disabled { cursor: not-allowed; }
.ui-combobox[data-disabled='true'] .ui-combobox__control { background: var(--bg-subtle); opacity: 0.7; }
.ui-combobox__chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  height: 22px;
  padding: 0 2px 0 6px;
  font-size: var(--fs-11);
  color: var(--text-soft);
  background: var(--bg-selected);
  border-radius: var(--r-xs);
}
.ui-combobox__chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-combobox__chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  color: var(--text-muted);
  background: none;
  border: 0;
  border-radius: var(--r-xs);
  cursor: pointer;
}
.ui-combobox__chip-remove:hover { color: var(--text); background: var(--bg-hover); }
.ui-combobox__chevron { display: inline-flex; flex: none; color: var(--text-muted); pointer-events: none; }
.ui-combobox__panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 70;
  max-height: 280px;
  overflow: auto;
  padding: 4px;
  background: var(--surface-1);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-md);
  animation: ui-combobox-in var(--dur-fast) var(--ease-enter);
}
.ui-combobox__group {
  padding: 6px 8px 3px;
  font-size: var(--fs-11);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.ui-combobox__option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  font-family: inherit;
  font-size: var(--fs-12);
  text-align: left;
  color: var(--text);
  background: none;
  border: 0;
  border-radius: var(--r-xs);
  cursor: pointer;
}
.ui-combobox__option[data-active='true'] { background: var(--bg-hover); }
.ui-combobox__option[aria-selected='true'] { color: var(--accent); }
.ui-combobox__option-main { min-width: 0; flex: 1; }
.ui-combobox__option-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-combobox__option-hint { margin-top: 1px; font-size: var(--fs-11); color: var(--text-muted); }
.ui-combobox__check { display: inline-flex; flex: none; color: var(--accent); }
.ui-combobox__none { padding: 10px 8px; font-size: var(--fs-12); color: var(--text-muted); }
@keyframes ui-combobox-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
@media (hover: hover) {
  .ui-combobox__option:hover { background: var(--bg-hover); }
}
@media (prefers-reduced-motion: reduce) {
  .ui-combobox__control { transition: none; }
  .ui-combobox__panel { animation: none; }
}
}
`

export function Combobox<V extends string | string[] = string>({
  options,
  value,
  onChange,
  multiple = false,
  creatable = false,
  placeholder,
  'aria-label': ariaLabel,
  disabled = false,
  width,
  className,
  id,
}: ComboboxProps<V>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`
  const picked = useMemo<string[]>(() => {
    if (Array.isArray(value)) return value.map(String)
    return value === undefined || value === null ? [] : [String(value)]
  }, [value])
  const single = !multiple

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = options.filter((option) => {
      if (!needle) return true
      return `${option.label} ${option.hint ?? ''} ${option.value}`.toLowerCase().includes(needle)
    })
    if (creatable && needle && !options.some((option) => option.label.toLowerCase() === needle || option.value.toLowerCase() === needle)) {
      return [
        { value: query.trim(), label: query.trim(), group: 'Create', hint: 'Use this value' },
        ...filtered,
      ]
    }
    return filtered
  }, [options, query, creatable])

  const selectedLabel = single ? (options.find((option) => option.value === picked[0])?.label ?? picked[0] ?? '') : ''
  const current = visible.length === 0 ? null : visible[Math.min(active, visible.length - 1)]

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    setActive(0)
  }, [query, open])

  const show = () => {
    if (disabled) return
    setOpen(true)
    setQuery('')
    setActive(0)
  }

  const close = () => {
    setOpen(false)
    setQuery('')
    setActive(0)
  }

  const choose = (option: ComboboxOption) => {
    if (multiple) {
      const next = picked.includes(option.value)
        ? picked.filter((entry) => entry !== option.value)
        : [...picked, option.value]
      onChange(next as V)
      setQuery('')
      setActive(0)
      input.current?.focus()
      return
    }
    onChange(option.value as V)
    close()
    input.current?.focus()
  }

  const remove = (entry: string) => {
    onChange(picked.filter((value) => value !== entry) as V)
    input.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) show()
      else setActive((index) => Math.min(index + 1, visible.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) show()
      else setActive((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Home' && open) {
      event.preventDefault()
      setActive(0)
    } else if (event.key === 'End' && open) {
      event.preventDefault()
      setActive(Math.max(visible.length - 1, 0))
    } else if (event.key === 'Enter') {
      if (open && current) {
        event.preventDefault()
        choose(current)
      } else if (creatable && query.trim()) {
        event.preventDefault()
        choose({ value: query.trim(), label: query.trim() })
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Tab') {
      if (open) close()
    } else if (event.key === 'Backspace' && multiple && query === '' && picked.length > 0) {
      event.preventDefault()
      remove(picked[picked.length - 1])
    }
  }

  let lastGroup: string | undefined
  return (
    <>
      <style href="ui-combobox" precedence="default">{css}</style>
      <div
        ref={root}
        className={cx('ui-combobox', className)}
        data-open={open ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        style={width === undefined ? undefined : ({ width } as CSSProperties)}
      >
        <div className="ui-combobox__control" onMouseDown={() => !open && !disabled && show()}>
          {multiple &&
            picked.map((entry) => {
              const label = options.find((option) => option.value === entry)?.label ?? entry
              return (
                <span key={entry} className="ui-combobox__chip">
                  <span className="ui-combobox__chip-label">{label}</span>
                  <button
                    type="button"
                    className="ui-combobox__chip-remove"
                    aria-label={`Remove ${label}`}
                    disabled={disabled}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    onClick={() => remove(entry)}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </span>
              )
            })}
          <input
            ref={input}
            id={id}
            className="ui-combobox__input"
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && current ? optionId(visible.indexOf(current)) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            disabled={disabled}
            value={open ? query : multiple ? '' : selectedLabel}
            placeholder={open && single && selectedLabel ? selectedLabel : placeholder}
            onChange={(event) => {
              if (!open) setOpen(true)
              setQuery(event.target.value)
            }}
            onFocus={show}
            onKeyDown={onKeyDown}
          />
          <span className="ui-combobox__chevron" aria-hidden="true">
            <Icon name="chevronDown" size={16} />
          </span>
        </div>
        {open && (
          <div className="ui-combobox__panel" role="listbox" id={listId} aria-label={ariaLabel} aria-multiselectable={multiple || undefined}>
            {visible.length === 0 && <div className="ui-combobox__none">No match.</div>}
            {visible.map((option, index) => {
              const group = option.group
              const heading = group !== lastGroup ? <div className="ui-combobox__group">{group ?? 'Options'}</div> : null
              lastGroup = group
              return (
                <Fragment key={`${option.value}-${index}`}>
                  {heading}
                  <button
                    type="button"
                    id={optionId(index)}
                    role="option"
                    aria-selected={picked.includes(option.value)}
                    className="ui-combobox__option"
                    data-active={index === active ? 'true' : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(option)}
                  >
                    <span className="ui-combobox__option-main">
                      <span className="ui-combobox__option-label">{option.label}</span>
                      {option.hint && <span className="ui-combobox__option-hint">{option.hint}</span>}
                    </span>
                    {picked.includes(option.value) && (
                      <span className="ui-combobox__check" aria-hidden="true">
                        <Icon name="check" size={16} />
                      </span>
                    )}
                  </button>
                </Fragment>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
