import { useEffect, useId, useRef, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Join class names, dropping the false branches. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx('ui-kbd', className)}>{children}</kbd>;
}

export function Badge({ children, tone = 'neutral', dot = false, className, title }: {
  children?: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info'; dot?: boolean; className?: string; title?: string;
}) {
  return <span className={cx('ui-badge', `ui-badge--${tone}`, className)} title={title}>{dot && <span className="ui-badge__dot" aria-hidden="true"/>}{children}</span>;
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children?: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
}

export function Button({ children, variant = 'secondary', size = 'md', icon, className, type = 'button', ...rest }: ButtonProps) {
  const iconOnly = children === undefined || children === null || children === false;
  return <button {...rest} type={type} className={cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, iconOnly && 'ui-btn--icon', className)}>
    {icon && <span className="ui-btn__icon" aria-hidden="true">{icon}</span>}{children}
  </button>;
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title: ReactNode; children: ReactNode }) {
  return <div className={cx('ui-notice', `ui-notice--${tone}`)} role={tone === 'warn' || tone === 'danger' ? 'alert' : 'status'}>
    <strong className="ui-notice__title">{title}</strong>
    <div className="ui-notice__body">{children}</div>
  </div>;
}

export function SettingRow({ label, description, control, danger }: { label: ReactNode; description?: ReactNode; control: ReactNode; danger?: boolean }) {
  return <div className={cx('ui-setting-row', danger && 'ui-setting-row--danger')}>
    <div className="ui-setting-row__text">
      <span className="ui-setting-row__label">{label}</span>
      {description && <span className="ui-setting-row__desc">{description}</span>}
    </div>
    {control && <div className="ui-setting-row__control">{control}</div>}
  </div>;
}

export function DescList({ items, className }: { items: { label: string; value: ReactNode; mono?: boolean }[]; className?: string }) {
  return <dl className={cx('ui-desc-list', className)}>
    {items.map(i => <div key={i.label} style={{ display: 'contents' }}>
      <dt className="ui-desc-list__label">{i.label}</dt>
      <dd className={cx('ui-desc-list__value', i.mono && 'ui-desc-list__value--mono')}>{i.value}</dd>
    </div>)}
  </dl>;
}

export function StatusDot({ tone = 'neutral', size = 'md', label }: { tone?: 'neutral' | 'accent' | 'success' | 'warn' | 'danger'; size?: 'sm' | 'md'; label?: string }) {
  return <span className="ui-status-dot"><span className={cx('ui-status-dot__pip', `ui-status-dot__pip--${tone}`, `ui-status-dot__pip--${size}`)} aria-hidden={label ? undefined : true}/>{label}</span>;
}

/** The native scroller; `autoHeight` sizes to the content up to `maxHeight`. */
export function ScrollArea({ children, className, style, viewProps, viewRef, autoHeight, maxHeight }: {
  children: ReactNode; className?: string; style?: CSSProperties; viewProps?: HTMLAttributes<HTMLElement>; viewRef?: Ref<HTMLElement>; autoHeight?: boolean; maxHeight?: number | string;
}) {
  const { className: viewClass, style: viewStyle, ...view } = viewProps ?? {};
  return <div className={cx('ui-scroll', className)} style={style}>
    <div {...view} ref={viewRef as Ref<HTMLDivElement>} className={cx('ui-scroll__view', viewClass)}
      style={{ overflowY: 'auto', maxHeight: autoHeight ? maxHeight : undefined, height: autoHeight ? undefined : '100%', ...viewStyle }}>{children}</div>
  </div>;
}

const focusable = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = `${useId()}-title`;
  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (panel.current?.querySelector<HTMLElement>(focusable) ?? panel.current)?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (!e.defaultPrevented) { e.preventDefault(); onCloseRef.current(); } return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const nodes = [...panel.current.querySelectorAll<HTMLElement>(focusable)].filter(n => n.offsetParent !== null || n === document.activeElement);
      if (!nodes.length) { e.preventDefault(); panel.current.focus(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); restore?.focus(); };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="ui-dialog__backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="ui-dialog">
        <div className="ui-dialog__header">
          <div id={titleId} className="ui-dialog__title">{title}</div>
          <Button variant="ghost" size="sm" aria-label="Close dialog" icon={<X size={16}/>} onClick={onClose}/>
        </div>
        <div className="ui-dialog__body">{children}</div>
        {footer && <div className="ui-dialog__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
