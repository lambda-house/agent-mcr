import { createElement, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { cx } from './cx'

export interface ScrollAreaProps {
  children: ReactNode
  className?: string
  /** The outer box. It fills its parent (`100%` x `100%`); in a flex column give it `flex: 1; minHeight: 0` instead. */
  style?: CSSProperties
  /** The element that scrolls: `main` for a page's content, `nav` for a sidebar. Default `div`. */
  as?: 'div' | 'main' | 'nav' | 'aside' | 'section' | 'ul'
  /** Props for the scrolling element itself: `id`, `tabIndex`, `role`, `aria-label`, `className`, `style`. */
  viewProps?: HTMLAttributes<HTMLElement>
  /** A handle on the scrolling element, for `scrollTop`, `scrollIntoView` and focus. */
  viewRef?: Ref<HTMLElement>
  /** Size to the content up to `maxHeight` instead of filling the parent (a table, a panel with a header). */
  autoHeight?: boolean
  maxHeight?: number | string
  /** Kept for API compatibility; native thin scrollbars already adapt to OS/hover. */
  autoHide?: boolean
}

const css = `
@layer teob-ui {
.ui-scroll {
  width: 100%;
  min-width: 0;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--line-strong) transparent;
}
.ui-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.ui-scroll::-webkit-scrollbar-track { background: transparent; }
.ui-scroll::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: var(--r-full); }
.ui-scroll::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
}
`

/** A native scroll container with thin, token-coloured scrollbars. */
export function ScrollArea({ children, className, style, as = 'div', viewProps, viewRef, autoHeight = false, maxHeight }: ScrollAreaProps) {
  const { className: viewClass, style: viewStyle, ...rest } = viewProps ?? {}
  return (
    <>
      <style href="ui-scroll-area" precedence="default">{css}</style>
      {createElement(
        as,
        {
          ...rest,
          ref: viewRef,
          className: cx('ui-scroll', className, viewClass),
          style: {
            ...(autoHeight ? undefined : { height: '100%' }),
            ...(autoHeight && maxHeight !== undefined ? { maxHeight } : undefined),
            ...style,
            ...viewStyle,
          },
        },
        children,
      )}
    </>
  )
}
