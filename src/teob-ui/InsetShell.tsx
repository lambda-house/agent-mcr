import type { ReactNode } from 'react'

export interface InsetShellProps {
  /** The navigation: it sits on the canvas, with no panel colour and no divider. Omit it for a single column. */
  sidebar?: ReactNode
  /** Sidebar width, default 240 px. */
  sidebarWidth?: number
  children: ReactNode
}

const css = `
@layer teob-ui {
.ui-shell { display: grid; height: 100%; min-height: 0; overflow: hidden; padding: 0 var(--shell-inset) var(--shell-inset); --shell-inset: 8px; }
.ui-shell--sidebar { padding-left: 0; }
.ui-shell__content {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface-1);
  border: 1px solid var(--line);
  border-radius: var(--r-xl);
}
}
`

/** The app frame: navigation on the canvas, the content a rounded, bordered `surface-1` container inset from the window
 *  edges. Put the app's scroll area (a `ScrollArea` or a `Page`) inside; nothing else draws a surface at this level. */
export function InsetShell({ sidebar, sidebarWidth = 240, children }: InsetShellProps) {
  return (
    <>
      <style href="ui-inset-shell" precedence="default">{css}</style>
      <div
        className={sidebar ? 'ui-shell ui-shell--sidebar' : 'ui-shell'}
        style={{ gridTemplateColumns: sidebar ? `${sidebarWidth}px minmax(0, 1fr)` : 'minmax(0, 1fr)' }}
      >
        {sidebar}
        <div className="ui-shell__content">{children}</div>
      </div>
    </>
  )
}
