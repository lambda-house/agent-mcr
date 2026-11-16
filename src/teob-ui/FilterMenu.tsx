import { useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { Popover } from './Popover'
import { cx } from './cx'

export interface FilterOption {
  value: string
  label: string
  count?: number
}

export interface FilterGroup {
  key: string
  label: string
  options: FilterOption[]
}

export interface FilterMenuProps {
  groups: FilterGroup[]
  value: Record<string, string[]>
  onChange: (value: Record<string, string[]>) => void
  onClear: () => void
  label?: string
  /** For the showcase: open on mount. */
  defaultOpen?: boolean
  className?: string
}

const css = `
@layer teob-ui {
.ui-filter-menu { position: relative; display: inline-flex; }
.ui-filter-menu__trigger {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface-1);
  color: var(--text);
}
.ui-filter-menu__trigger[aria-expanded='true'] { background: var(--bg-hover); }
.ui-filter-menu__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: var(--fs-11);
  font-weight: 600;
  line-height: 1;
  color: var(--accent);
  background: var(--accent-bg);
  border-radius: var(--r-full);
}
.ui-filter-menu__panel { width: 300px; padding: 8px; }
.ui-filter-menu__head { display: flex; align-items: center; gap: 8px; padding: 0 4px 6px; }
.ui-filter-menu__title { flex: 1; font-size: var(--fs-12); font-weight: 600; color: var(--text); }
.ui-filter-menu__clear {
  padding: 2px 4px;
  font-family: inherit;
  font-size: var(--fs-12);
  color: var(--text-muted);
  background: none;
  border: 0;
  border-radius: var(--r-xs);
  cursor: pointer;
}
.ui-filter-menu__clear:disabled { opacity: 0.45; cursor: default; }
.ui-filter-menu__chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 4px 8px; }
.ui-filter-menu__chips:empty { display: none; }
.ui-filter-menu__chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  height: 22px;
  padding: 0 2px 0 7px;
  font-size: var(--fs-11);
  color: var(--text-soft);
  background: var(--bg-selected);
  border-radius: var(--r-xs);
}
.ui-filter-menu__chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-filter-menu__chip-remove {
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
.ui-filter-menu__group { border-top: 1px solid var(--line); padding: 6px 0 2px; }
.ui-filter-menu__group:first-of-type { border-top: 0; }
.ui-filter-menu__group-label {
  padding: 4px 6px 2px;
  font-size: var(--fs-11);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.ui-filter-menu__option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 3px 6px;
  font-family: inherit;
  font-size: var(--fs-12);
  text-align: left;
  color: var(--text);
  background: none;
  border: 0;
  border-radius: var(--r-xs);
  cursor: pointer;
}
.ui-filter-menu__option[data-active='true'] { background: var(--bg-hover); }
.ui-filter-menu__box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--text-inverse);
  background: var(--surface-1);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-xs);
}
.ui-filter-menu__option[aria-checked='true'] .ui-filter-menu__box { background: var(--text); border-color: var(--text); }
.ui-filter-menu__option-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-filter-menu__option-count { font-size: var(--fs-11); color: var(--text-muted); font-variant-numeric: tabular-nums; }
@media (hover: hover) {
  .ui-filter-menu__trigger:hover { background: var(--bg-hover); }
  .ui-filter-menu__clear:hover:not(:disabled) { color: var(--text); background: var(--bg-hover); }
  .ui-filter-menu__chip-remove:hover { color: var(--text); background: var(--bg-hover); }
  .ui-filter-menu__option:hover { background: var(--bg-hover); }
}
@media (prefers-reduced-motion: reduce) {
  .ui-filter-menu__trigger, .ui-filter-menu__clear, .ui-filter-menu__chip-remove { transition: none; }
}
}
`

export function FilterMenu({ groups, value, onChange, onClear, label = 'Filters', defaultOpen = false, className }: FilterMenuProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [focusIndex, setFocusIndex] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  const pickedIn = (key: string) => (Array.isArray(value[key]) ? value[key] : [])
  const chips = groups.flatMap((group) =>
    group.options
      .filter((option) => pickedIn(group.key).includes(option.value))
      .map((option) => ({ group, option }))
  )
  const activeGroups = groups.filter((group) => pickedIn(group.key).length > 0).length

  const rows = groups.flatMap((group) => group.options.map((option) => ({ group, option })))

  const focusAt = (index: number) => {
    if (rows.length === 0) return
    const next = Math.max(0, Math.min(index, rows.length - 1))
    setFocusIndex(next)
    optionRefs.current[next]?.focus()
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    setOpen(true)
    window.setTimeout(() => focusAt(event.key === 'ArrowDown' ? 0 : rows.length - 1), 0)
  }

  const toggle = (groupKey: string, optionValue: string) => {
    const current = pickedIn(groupKey)
    const next = current.includes(optionValue)
      ? current.filter((entry) => entry !== optionValue)
      : [...current, optionValue]
    onChange({ ...value, [groupKey]: next })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(focusIndex + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(focusIndex - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(rows.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      const row = rows[focusIndex]
      if (!row) return
      event.preventDefault()
      toggle(row.group.key, row.option.value)
    }
  }

  return (
    <>
      <style href="ui-filter-menu" precedence="default">{css}</style>
      <Popover
        open={open}
        onOpenChange={setOpen}
        className={cx('ui-filter-menu', className)}
        triggerClassName="ui-filter-menu__trigger"
        ariaLabel={label}
        panelRef={panel}
        triggerProps={{ onKeyDown: onTriggerKeyDown }}
        trigger={
          <>
            {label}
            {activeGroups > 0 && <span className="ui-filter-menu__count">{activeGroups}</span>}
            <Icon name="chevronDown" size={16} />
          </>
        }
      >
        <div className="ui-filter-menu__panel" onKeyDown={onKeyDown}>
          <div className="ui-filter-menu__head">
            <span className="ui-filter-menu__title">{label}</span>
            <button
              type="button"
              className="ui-filter-menu__clear"
              disabled={chips.length === 0}
              onClick={() => {
                onChange({})
                onClear()
              }}
            >
              Clear all
            </button>
          </div>
          {chips.length > 0 && (
            <div className="ui-filter-menu__chips">
              {chips.map(({ group, option }) => (
                <span key={`${group.key}:${option.value}`} className="ui-filter-menu__chip">
                  <span className="ui-filter-menu__chip-label">{option.label}</span>
                  <button
                    type="button"
                    className="ui-filter-menu__chip-remove"
                    aria-label={`Remove ${option.label}`}
                    onClick={() => toggle(group.key, option.value)}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.key} className="ui-filter-menu__group" role="group" aria-label={group.label}>
              <div className="ui-filter-menu__group-label">{group.label}</div>
              {group.options.map((option) => {
                const rowIndex = rows.findIndex((row) => row.group.key === group.key && row.option.value === option.value)
                const checked = pickedIn(group.key).includes(option.value)
                return (
                  <button
                    key={option.value}
                    ref={(element) => {
                      optionRefs.current[rowIndex] = element
                    }}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    tabIndex={rowIndex === focusIndex ? 0 : -1}
                    data-active={rowIndex === focusIndex ? 'true' : undefined}
                    className="ui-filter-menu__option"
                    onFocus={() => setFocusIndex(rowIndex)}
                    onClick={() => toggle(group.key, option.value)}
                  >
                    <span className="ui-filter-menu__box" aria-hidden="true">
                      {checked && <Icon name="check" size={16} />}
                    </span>
                    <span className="ui-filter-menu__option-label">{option.label}</span>
                    {option.count !== undefined && <span className="ui-filter-menu__option-count">{option.count}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </Popover>
    </>
  )
}
