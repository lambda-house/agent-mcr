import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Skeleton } from './Skeleton'
import { EmptyLine } from './State'
import { cx } from './cx'
import { AnimatePresence, m, motionEnter, motionExit } from './motion'
import { ScrollArea } from './ScrollArea'

export interface Column<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  /** Sort comparator; without one the header is not a sort control. */
  sort?: (a: T, b: T) => number
  width?: number | string
  align?: 'left' | 'right'
}

export type SortDirection = 'asc' | 'desc'

export interface DataTableProps<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  /** Some rows are not actions (e.g. a journal event with no fact): they keep focus but do not open. */
  rowClickable?: (row: T) => boolean
  selectedKey?: string | null
  loading?: boolean
  skeletonRows?: number
  empty?: ReactNode
  ariaLabel?: string
  initialSort?: { key: string; direction: SortDirection } | null
  /** Give the wrapper a height so the sticky header has a scrollport; the page itself keeps scrolling only when it must. */
  maxHeight?: number | string
  /** 32 px rows for a small table inside a panel; the default is 40. */
  dense?: boolean
  /** Rows that appear after the first render fade in and rows that go fade out; for tables whose rows come and go by an
   *  action (a fact written, a run finished), not for ones that refilter on every keystroke. */
  animateRows?: boolean
  className?: string
}

const css = `
@layer teob-ui {
.ui-table-wrap {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--bg-panel);
}
.ui-table-view { overscroll-behavior: contain; }
.ui-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--fs-13); }
.ui-table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 32px;
  padding: 0 12px;
  text-align: left;
  vertical-align: middle;
  white-space: nowrap;
  font-size: var(--fs-11);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--line);
}
.ui-table th[data-align='right'] { text-align: right; }
.ui-table__sort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}
.ui-table__sort:hover { color: var(--text); }
.ui-table__sort-icon { display: inline-flex; width: 12px; height: 12px; color: var(--text-muted); }
.ui-table__sort-icon svg { width: 12px; height: 12px; }
.ui-table tbody tr { height: 40px; }
.ui-table--dense tbody tr { height: 32px; }
.ui-table tbody tr[data-clickable='true'] { cursor: pointer; }
.ui-table tbody td {
  padding: 4px 12px;
  vertical-align: middle;
  border-bottom: 1px solid var(--line);
  color: var(--text-soft);
  overflow-wrap: anywhere;
}
.ui-table tbody tr:last-child td { border-bottom: 0; }
.ui-table td[data-align='right'] { text-align: right; font-variant-numeric: tabular-nums; }
.ui-table tbody tr[data-selected='true'] td { background: var(--bg-selected); color: var(--text); }
.ui-table tbody tr[data-selected='true'] td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
@media (hover: hover) {
  .ui-table tbody tr[data-clickable='true']:not([data-selected='true']):hover td { background: var(--bg-hover); }
}
.ui-table tbody tr:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ui-table__empty { padding: 12px 12px; }
.ui-table__state { padding: 16px 12px; }
@media (prefers-reduced-motion: reduce) {
  .ui-table__sort { transition: none; }
}
}
`

function SortIcon({ direction }: { direction: SortDirection | null }) {
  if (!direction) {
    return (
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
        <path d="M6 2v8M3.5 4.5 6 2l2.5 2.5M3.5 7.5 6 10l2.5-2.5" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      {direction === 'asc' ? <path d="M6 10V2M3.5 4.5 6 2l2.5 2.5" /> : <path d="M6 2v8M3.5 7.5 6 10l2.5-2.5" />}
    </svg>
  )
}

const motionRow = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: motionEnter },
  exit: { opacity: 0, transition: motionExit },
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  rowClickable,
  selectedKey,
  loading = false,
  skeletonRows = 8,
  empty,
  ariaLabel,
  initialSort = null,
  maxHeight,
  dense = false,
  animateRows = false,
  className,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; direction: SortDirection } | null>(initialSort)
  const [focusIndex, setFocusIndex] = useState(0)
  const Row = animateRows ? m.tr : 'tr'
  const withPresence = (nodes: ReactNode) => (animateRows ? <AnimatePresence initial={false}>{nodes}</AnimatePresence> : nodes)
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([])

  const sorted = useMemo(() => {
    if (!sort) return rows
    const column = columns.find((c) => c.key === sort.key)
    if (!column?.sort) return rows
    const copy = [...rows].sort(column.sort)
    return sort.direction === 'asc' ? copy : copy.reverse()
  }, [rows, columns, sort])

  useEffect(() => {
    if (selectedKey == null) return
    const index = sorted.findIndex((row) => rowKey(row) === selectedKey)
    if (index >= 0) setFocusIndex(index)
  }, [selectedKey, sorted, rowKey])

  const cycle = (column: Column<T>) => {
    if (!column.sort) return
    setSort((current) => {
      if (!current || current.key !== column.key) return { key: column.key, direction: 'asc' }
      if (current.direction === 'asc') return { key: column.key, direction: 'desc' }
      return null
    })
  }

  const move = (index: number, delta: number) => {
    const last = sorted.length - 1
    if (last < 0) return
    const next = Math.max(0, Math.min(last, index + delta))
    setFocusIndex(next)
    rowRefs.current[next]?.focus()
  }

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: T) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(index, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(index, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      move(index, -index)
    } else if (event.key === 'End') {
      event.preventDefault()
      move(index, sorted.length - 1 - index)
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (!onRowClick || (rowClickable && !rowClickable(row))) return
      event.preventDefault()
      onRowClick(row)
    }
  }

  return (
    <>
      <style href="ui-data-table" precedence="default">{css}</style>
      <ScrollArea className={cx('ui-table-wrap', className)} autoHeight maxHeight={maxHeight} viewProps={{ className: 'ui-table-view' }}>
        <table className={cx('ui-table', dense && 'ui-table--dense')} aria-label={ariaLabel} aria-busy={loading || undefined}>
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={column.width === undefined ? undefined : { width: column.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort?.key === column.key ? sort.direction : null
                return (
                  <th
                    key={column.key}
                    scope="col"
                    data-align={column.align ?? 'left'}
                    aria-sort={column.sort ? (active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none') : undefined}
                  >
                    {column.sort ? (
                      <button type="button" className="ui-table__sort" onClick={() => cycle(column)}>
                        {column.header}
                        <span className="ui-table__sort-icon" aria-hidden="true">
                          <SortIcon direction={active} />
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: skeletonRows }, (_, row) => (
                  <tr key={`skeleton-${row}`} aria-hidden="true">
                    {columns.map((column, columnIndex) => (
                      <td key={column.key} data-align={column.align ?? 'left'}>
                        <Skeleton
                          height={12}
                          radius="var(--r-xs)"
                          width={columnIndex === 0 ? '55%' : columnIndex === 1 ? '92%' : '65%'}
                        />
                      </td>
                    ))}
                  </tr>
                ))
              : withPresence(
                  sorted.map((row, index) => {
                  const key = rowKey(row)
                  const selected = selectedKey != null && selectedKey === key
                  const clickable = !!onRowClick && (!rowClickable || rowClickable(row))
                  return (
                    <Row
                      key={key}
                      {...(animateRows ? motionRow : undefined)}
                      ref={(element: HTMLTableRowElement | null) => {
                        rowRefs.current[index] = element
                      }}
                      data-clickable={clickable ? 'true' : undefined}
                      data-selected={selected ? 'true' : undefined}
                      aria-current={selected ? 'true' : undefined}
                      tabIndex={index === focusIndex ? 0 : -1}
                      onClick={() => {
                        setFocusIndex(index)
                        if (clickable) onRowClick?.(row)
                      }}
                      onFocus={() => setFocusIndex(index)}
                      onKeyDown={(event) => onRowKeyDown(event, index, row)}
                    >
                      {columns.map((column) => (
                        <td key={column.key} data-align={column.align ?? 'left'}>
                          {column.render(row)}
                        </td>
                      ))}
                    </Row>
                  )
                }),
                )}
            {!loading && sorted.length === 0 && (
              <tr>
                <td colSpan={columns.length}>
                  <div className="ui-table__empty">{empty ?? <EmptyLine>No rows.</EmptyLine>}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollArea>
    </>
  )
}
