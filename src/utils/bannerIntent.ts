import { create } from 'zustand';

/**
 * A clicked macOS banner's ask to show a session (MCR-180), app-level state:
 * the page's banner handler sets it before React renders anything for it, so
 * Sessions and Live see it in their first render. While it is set, Live sends
 * no acknowledgement and no terminal takes the keyboard or sends anything.
 * It ends when Live has decided it on a list read that began after the ask,
 * when a click on a banner about no session takes it back, or when the
 * operator makes a choice of their own in Live. While a click is being taken
 * from the app (`taking`), Live decides no ask: that click is newer and may
 * take the ask back or replace it.
 */
export type BannerIntent = { id: string; at: number };

export const useBannerIntent = create<{ intent: BannerIntent | null; asked: number; taking: number }>(() => ({ intent: null, asked: 0, taking: 0 }));

/** A click on a banner about `id`. */
export function askBanner(id: string): void {
  const asked = useBannerIntent.getState().asked + 1;
  useBannerIntent.setState({ intent: { id, at: asked }, asked });
}

/** A click on a banner about no session, or the operator's own choice: nothing waits any more. */
export function cancelBanner(): void {
  if (useBannerIntent.getState().intent) useBannerIntent.setState({ intent: null });
}

/** Live decided the ask `at` (shown it, or said it no longer runs); a later ask stays. */
export function settleBanner(at: number): void {
  if (useBannerIntent.getState().intent?.at === at) useBannerIntent.setState({ intent: null });
}

/** A take of the app's latest click starts: no ask is decided until it ends. */
export function beginTake(): void {
  useBannerIntent.setState(s => ({ taking: s.taking + 1 }));
}

/** That take ended, after its click (if any) was handed to the page. */
export function endTake(): void {
  useBannerIntent.setState(s => ({ taking: Math.max(0, s.taking - 1) }));
}
