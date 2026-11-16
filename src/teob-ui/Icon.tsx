import type { CSSProperties, ReactNode } from 'react'
import { cx } from './cx'

/** The console's inline stroke icons: 24-unit grid, currentColor, no icon library. `label` names the icon for a screen
 *  reader; without it the icon is decoration and hidden from the accessibility tree. */
export type IconName =
  | 'overview'
  | 'memories'
  | 'activity'
  | 'review'
  | 'usage'
  | 'access'
  | 'settings'
  | 'moreVertical'
  | 'search'
  | 'plus'
  | 'chevronDown'
  | 'chevronRight'
  | 'chevronLeft'
  | 'close'
  | 'check'
  | 'alert'
  | 'info'
  | 'lock'
  | 'menu'
  | 'copy'
  | 'external'
  | 'trash'
  | 'clock'
  | 'sun'
  | 'moon'
  | 'user'
  | 'filter'
  | 'key'
  | 'refresh'
  | 'schema'
  | 'graph'
  | 'flask'
  | 'plug'
  | 'download'
  | 'pencil'

const paths: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  memories: (
    <>
      <path d="M12 3.5 20 8l-8 4.5L4 8l8-4.5Z" />
      <path d="m4 12 8 4.5 8-4.5" />
      <path d="m4 16 8 4.5 8-4.5" />
    </>
  ),
  activity: <path d="M3.5 12h4l2.2-6 4.2 12 2.3-6h4.3" />,
  review: (
    <>
      <path d="M4 5.5h16v13H4z" />
      <path d="m8 12 2.5 2.5L16 9" />
    </>
  ),
  usage: (
    <>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-6" />
      <path d="M22 20H2" />
    </>
  ),
  access: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
      <path d="M16 5.5a3 3 0 0 1 0 5" />
      <path d="M17.5 14.2c1.8.6 2.9 2.3 3.2 4.8" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  moreVertical: (
    <>
      <circle cx="12" cy="5.5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="18.5" r="1" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15.5" r="3.5" />
      <path d="m10.6 12.9 8.4-8.4M15.5 8l2.5 2.5M17.5 6l2 2" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 10.5a7.5 7.5 0 0 0-13.6-3M4.5 4v3.5H8" />
      <path d="M4.5 13.5a7.5 7.5 0 0 0 13.6 3M19.5 20v-3.5H16" />
    </>
  ),
  schema: (
    <>
      <rect x="9" y="3.5" width="6" height="5" rx="1.2" />
      <rect x="3.5" y="15.5" width="6" height="5" rx="1.2" />
      <rect x="14.5" y="15.5" width="6" height="5" rx="1.2" />
      <path d="M12 8.5V12M6.5 15.5V12h11v3.5" />
    </>
  ),
  graph: (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="18" cy="7" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.5 7h7M7.3 9.2l3.6 6.6M16.7 9.2l-3.6 6.6" />
    </>
  ),
  flask: (
    <>
      <path d="M9.5 3.5h5M10.5 3.5v6L5.2 18.6a1.5 1.5 0 0 0 1.3 2.4h11a1.5 1.5 0 0 0 1.3-2.4L13.5 9.5v-6" />
      <path d="M8 15h8" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3.5v5M15 3.5v5" />
      <path d="M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0v-3ZM12 17v3.5" />
    </>
  ),
  download: <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />,
  pencil: <path d="m4 20 1-4L16.5 4.5a2 2 0 0 1 3 3L8 19l-4 1Z" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15.2 15.2 4.3 4.3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  chevronLeft: <path d="m14.5 6-6 6 6 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 3.8 21 20H3l9-16.2Z" />
      <path d="M12 9.5v4.7" />
      <path d="M12 17.3v.2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6v.2" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="10" rx="2" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </>
  ),
  external: (
    <>
      <path d="M13.5 4.5H20v6.5" />
      <path d="m20 4.5-8 8" />
      <path d="M18 14.5v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h4" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h3.4A1.3 1.3 0 0 1 15 4.8v1.7" />
      <path d="M6.5 6.5 7.3 20a1.3 1.3 0 0 0 1.3 1.2h6.8a1.3 1.3 0 0 0 1.3-1.2l.8-13.5" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.3l3.4 2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6" />
    </>
  ),
  moon: <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.7-3.7 3.4-5.6 7-5.6s6.3 1.9 7 5.6" />
    </>
  ),
  filter: <path d="M3.5 5.5h17l-6.6 7.6v5.6l-3.8 2v-7.6L3.5 5.5Z" />,
}

export interface IconProps {
  name: IconName
  size?: 16 | 18 | 20
  /** Names the icon; without it the icon is decorative and `aria-hidden`. */
  label?: string
  className?: string
  style?: CSSProperties
}

const css = `
@layer teob-ui {
.ui-icon { display: inline-block; flex: none; vertical-align: middle; overflow: visible; }
}
`

export function Icon({ name, size = 16, label, className, style }: IconProps) {
  return (
    <>
      <style href="ui-icon" precedence="default">{css}</style>
      <svg
        className={cx('ui-icon', className)}
        style={style}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        focusable="false"
      >
        {paths[name]}
      </svg>
    </>
  )
}
