import { AnimatePresence, LazyMotion, MotionConfig, m, useReducedMotion, type Transition } from 'motion/react'
import type { ReactNode } from 'react'
import { cx } from './cx'

export { AnimatePresence, m, useReducedMotion }

/** The kit's motion tokens, in motion's units: `--dur-base` / `--dur-slow` and `--ease-enter` from tokens.css. */
export const motionEase = [0.22, 1, 0.36, 1] as const
export const motionEnter: Transition = { duration: 0.16, ease: motionEase }
export const motionExit: Transition = { duration: 0.12, ease: motionEase }

/** Loaded on demand, so the animation engine stays out of the entry bundle; until it arrives things simply do not move. */
const features = () => import('./motionFeatures').then((mod) => mod.default)

/** Wrap an app once. Everything that moves in the kit is `m.*` under this: it follows the person's reduced-motion
 *  setting (transforms drop out, opacity stays) and loads the engine lazily. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={features} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  )
}

/** A list whose items fade in when they appear after the first render and fade out when they leave. */
export function AnimatedList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </div>
  )
}

/** One row of an `AnimatedList`; the parent keys it. */
export function AnimatedItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <m.div
      className={cx(className)}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0, transition: motionEnter }}
      exit={{ opacity: 0, transition: motionExit }}
    >
      {children}
    </m.div>
  )
}
