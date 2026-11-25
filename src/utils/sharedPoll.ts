import { useEffect } from 'react';

/**
 * Data that several panes show (Board's reports and notes, Slack's posts and
 * connection): read once for all of them, now and every `ms` while at least
 * one of them is on screen, never while the window is hidden. Each pane calls
 * the returned hook with whether it is shown.
 */
export function sharedPoll(read: () => unknown, ms: number): (active: boolean) => void {
  let users = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  return function usePoll(active: boolean) {
    useEffect(() => {
      if (!active) return;
      // The first pane to show reads at once; the others see what it read
      if (++users === 1) {
        void read();
        timer = setInterval(() => { if (!document.hidden) void read(); }, ms);
      }
      return () => {
        if (--users === 0) { clearInterval(timer); timer = undefined; }
      };
    }, [active]);
  };
}
