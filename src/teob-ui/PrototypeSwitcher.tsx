import { useEffect, useState, type ReactNode } from 'react'
import { Badge } from './Badge'
import { Button } from './Button'
import { Icon } from './Icon'
import { SegmentedControl } from './Tabs'
import { cx } from './cx'

export type PrototypeDataset = 'live' | 'empty' | 'error' | 'worst'

export interface PrototypeOption<K extends string = string> {
  key: K
  label: string
  /** Short note on the macro-metaphor or synthesis recipe used in this variant. */
  metaphor?: string
  render: (dataset: PrototypeDataset) => ReactNode
}

export interface PrototypeSwitcherProps<K extends string = string> {
  /** URL query parameter name for the active variant; defaults to `proto`. */
  param?: string
  /** URL query parameter name for the active dataset; defaults to `dataset`. */
  datasetParam?: string
  title?: string
  options: readonly PrototypeOption<K>[]
  defaultOption?: K
  defaultDataset?: PrototypeDataset
  /** Show dataset stress-test controls (`live | empty | error | worst`). On by default. */
  showDatasetSwitch?: boolean
  className?: string
}

const datasetChoices: [PrototypeDataset, string][] = [
  ['live', 'Live'],
  ['empty', 'Empty'],
  ['error', 'Error'],
  ['worst', 'Worst case'],
]

function readHashParam(name: string): string | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash
  const qIndex = hash.indexOf('?')
  if (qIndex >= 0) {
    const params = new URLSearchParams(hash.slice(qIndex + 1))
    const val = params.get(name)
    if (val) return val
  }
  const searchParams = new URLSearchParams(window.location.search)
  return searchParams.get(name)
}

function writeHashParam(name: string, value: string) {
  if (typeof window === 'undefined') return
  const hash = window.location.hash
  if (hash.startsWith('#')) {
    const qIndex = hash.indexOf('?')
    const path = qIndex >= 0 ? hash.slice(0, qIndex) : hash
    const params = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '')
    params.set(name, value)
    const nextQuery = params.toString()
    const nextHash = nextQuery ? `${path}?${nextQuery}` : path
    window.history.replaceState(null, '', nextHash)
    return
  }
  const url = new URL(window.location.href)
  url.searchParams.set(name, value)
  window.history.replaceState(null, '', url.toString())
}

const css = `
@layer teob-ui {
.ui-proto {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
}
.ui-proto__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-4);
  padding: 6px 10px;
  background: var(--bg-subtle);
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-md);
}
.ui-proto__left,
.ui-proto__right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  min-width: 0;
}
.ui-proto__title {
  font-size: var(--fs-11);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.ui-proto__metaphor {
  font-size: var(--fs-12);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-proto__canvas {
  min-width: 0;
}
}
`

/**
 * Multi-variant interactive prototype harness (`/prototype` pattern).
 * Renders 2–3 distinct macro-metaphor variants behind an instant visual switcher,
 * persists the selection in the URL (`?proto=`), and lets the user toggle
 * dataset states (`live | empty | error | worst`) to pressure-test the UI.
 */
export function PrototypeSwitcher<K extends string = string>({
  param = 'proto',
  datasetParam = 'dataset',
  title = 'Prototype',
  options,
  defaultOption,
  defaultDataset = 'live',
  showDatasetSwitch = true,
  className,
}: PrototypeSwitcherProps<K>) {
  const fallbackKey = defaultOption ?? options[0]?.key
  const [activeKey, setActiveKey] = useState<K>(() => {
    const fromUrl = readHashParam(param)
    if (fromUrl && options.some((opt) => opt.key === fromUrl)) {
      return fromUrl as K
    }
    return fallbackKey
  })

  const [dataset, setDataset] = useState<PrototypeDataset>(() => {
    const fromUrl = readHashParam(datasetParam)
    if (fromUrl === 'live' || fromUrl === 'empty' || fromUrl === 'error' || fromUrl === 'worst') {
      return fromUrl
    }
    return defaultDataset
  })

  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    if (activeKey && !options.some((opt) => opt.key === activeKey) && fallbackKey) {
      setActiveKey(fallbackKey)
    }
  }, [activeKey, fallbackKey, options])

  const current = options.find((opt) => opt.key === activeKey) ?? options[0]
  const tabs: [K, string][] = options.map((opt) => [opt.key, opt.label])

  const selectVariant = (next: K) => {
    setActiveKey(next)
    writeHashParam(param, next)
  }

  const selectDataset = (next: PrototypeDataset) => {
    setDataset(next)
    writeHashParam(datasetParam, next)
  }

  return (
    <>
      <style href="ui-prototype-switcher" precedence="default">{css}</style>
      <div className={cx('ui-proto', className)}>
        <div className="ui-proto__bar" role="region" aria-label={`${title} switcher`}>
          <div className="ui-proto__left">
            <Badge tone="accent">{title}</Badge>
            <SegmentedControl<K>
              aria-label={`${title} variant`}
              tabs={tabs}
              value={current.key}
              onChange={selectVariant}
            />
            {current?.metaphor && !collapsed && (
              <span className="ui-proto__metaphor" title={current.metaphor}>
                {current.metaphor}
              </span>
            )}
          </div>
          <div className="ui-proto__right">
            {showDatasetSwitch && !collapsed && (
              <>
                <span className="ui-proto__title">State</span>
                <SegmentedControl<PrototypeDataset>
                  aria-label="Prototype dataset state"
                  tabs={datasetChoices}
                  value={dataset}
                  onChange={selectDataset}
                />
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-label={collapsed ? 'Expand prototype bar' : 'Minimize prototype bar'}
              icon={<Icon name={collapsed ? 'chevronDown' : 'chevronRight'} size={16} />}
              onClick={() => setCollapsed((v) => !v)}
            />
          </div>
        </div>
        <div className="ui-proto__canvas">{current?.render(dataset)}</div>
      </div>
    </>
  )
}
