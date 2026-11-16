import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { cx } from './cx'

export interface StepperStep<K extends string = string> {
  key: K
  label: ReactNode
  description?: ReactNode
  done?: boolean
  current?: boolean
}

export interface StepperProps<K extends string = string> {
  steps: StepperStep<K>[]
  current: K
  onSelect?: (key: K) => void
  children: ReactNode
  footer?: ReactNode
  className?: string
}

const css = `
@layer teob-ui {
.ui-stepper { min-width: 0; }
.ui-stepper__list {
  display: flex;
  align-items: flex-start;
  gap: 0;
  margin: 0;
  padding: 0 0 4px;
  list-style: none;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.ui-stepper__list::-webkit-scrollbar { display: none; }
.ui-stepper__item { display: flex; align-items: flex-start; flex: 1 1 0; min-width: 0; }
.ui-stepper__connector {
  flex: 1 1 20px;
  min-width: 20px;
  height: 1px;
  margin-top: 18px;
  background: var(--line);
}
.ui-stepper__step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex: 0 1 auto;
  min-width: 0;
  padding: 4px 8px;
  font-family: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  color: inherit;
}
.ui-stepper__step--interactive { cursor: pointer; }
@media (hover: hover) {
  .ui-stepper__step--interactive:hover { background: var(--bg-hover); }
}
.ui-stepper__step:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ui-stepper__circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  font-size: var(--fs-11);
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  background: var(--bg-input);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-full);
}
.ui-stepper__step--done .ui-stepper__circle { color: var(--text-inverse); background: var(--ok); border-color: var(--ok); }
.ui-stepper__step--current .ui-stepper__circle { color: var(--text-inverse); background: var(--accent); border-color: var(--accent); }
.ui-stepper__text { min-width: 0; padding-top: 4px; }
.ui-stepper__label { display: block; font-size: var(--fs-13); font-weight: 500; line-height: 1.3; color: var(--text-muted); }
.ui-stepper__step--done .ui-stepper__label { color: var(--text-soft); }
.ui-stepper__step--current .ui-stepper__label { color: var(--text); font-weight: 600; }
.ui-stepper__description { display: block; margin-top: 2px; font-size: var(--fs-12); line-height: 1.4; color: var(--text-muted); }
.ui-stepper__content { margin-top: 20px; min-width: 0; }
.ui-stepper__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  flex-wrap: wrap;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
@media (max-width: 1024px) {
  .ui-stepper__item { flex: 0 0 auto; }
  .ui-stepper__connector { flex: none; width: 24px; min-width: 24px; }
  .ui-stepper__step { flex: none; }
  .ui-stepper__text { max-width: 150px; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-stepper__step { transition: none; }
}
}
`

/** A form's progress across numbered steps: done ticks, the current one in the accent, the content and footer below.
 *  Horizontal, and scrollable under 1024 px, so long labels never force the page sideways. */
export function Stepper<K extends string = string>({
  steps,
  current,
  onSelect,
  children,
  footer,
  className,
}: StepperProps<K>) {
  return (
    <>
      <style href="ui-stepper" precedence="default">{css}</style>
      <div className={cx('ui-stepper', className)}>
        <ol className="ui-stepper__list" aria-label="Steps">
          {steps.map((step, index) => {
            const isCurrent = step.current ?? step.key === current
            const body = (
              <>
                <span className="ui-stepper__circle" aria-hidden="true">
                  {step.done ? <Icon name="check" size={16} /> : index + 1}
                </span>
                <span className="ui-stepper__text">
                  <span className="ui-stepper__label">{step.label}</span>
                  {step.description && <span className="ui-stepper__description">{step.description}</span>}
                </span>
              </>
            )
            return (
              <li key={step.key} className="ui-stepper__item">
                {onSelect ? (
                  <button
                    type="button"
                    className={cx(
                      'ui-stepper__step',
                      'ui-stepper__step--interactive',
                      step.done && 'ui-stepper__step--done',
                      isCurrent && 'ui-stepper__step--current',
                    )}
                    aria-current={isCurrent ? 'step' : undefined}
                    onClick={() => onSelect(step.key)}
                  >
                    {body}
                  </button>
                ) : (
                  <div
                    className={cx(
                      'ui-stepper__step',
                      step.done && 'ui-stepper__step--done',
                      isCurrent && 'ui-stepper__step--current',
                    )}
                    aria-current={isCurrent ? 'step' : undefined}
                  >
                    {body}
                  </div>
                )}
                {index < steps.length - 1 && <span className="ui-stepper__connector" aria-hidden="true" />}
              </li>
            )
          })}
        </ol>
        <div className="ui-stepper__content">{children}</div>
        {footer && <div className="ui-stepper__footer">{footer}</div>}
      </div>
    </>
  )
}
