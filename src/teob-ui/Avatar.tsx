import { cx } from './cx'

export interface AvatarProps {
  name: string
  src?: string
  /** Pixels; 24 default. */
  size?: number
  className?: string
}

function initials(name: string): string {
  const words = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? words[words.length - 1]?.[0] ?? '' : ''
  return `${first}${last}`.toUpperCase()
}

const css = `
@layer teob-ui {
.ui-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  overflow: hidden;
  border-radius: var(--r-full);
  background: var(--accent-bg);
  border: 1px solid var(--accent-line);
  color: var(--accent);
  font-weight: 600;
  line-height: 1;
  text-transform: uppercase;
  user-select: none;
}
.ui-avatar__image { width: 100%; height: 100%; object-fit: cover; display: block; }
}
`

export function Avatar({ name, src, size = 24, className }: AvatarProps) {
  return (
    <>
      <style href="ui-avatar" precedence="default">{css}</style>
      <span
        className={cx('ui-avatar', className)}
        style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }}
        role="img"
        aria-label={name}
      >
        {src ? <img className="ui-avatar__image" src={src} alt="" /> : initials(name)}
      </span>
    </>
  )
}
