import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { harnessApi, pastedImage, shellQuote } from '../utils/harness';

/** How long the pane's size must stay the same before the terminal is fitted to it. */
export const RESIZE_SETTLE_MS = 200;

const err = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Colours from the Sessions palette the pane sits in (light and dark). */
function theme(element: HTMLElement) {
  const css = getComputedStyle(element);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--sc-bg', '#101519'),
    foreground: v('--sc-text', '#e4ecef'),
    cursor: v('--sc-accent', '#91d6b3'),
    selectionBackground: v('--sc-card', '#1c252c'),
  };
}

/**
 * One hosted terminal. Mounting attaches a view (the runner replays its
 * scrollback, then streams); unmounting detaches. The agent keeps running.
 *
 * Paste (docs/AGENT_HARNESS_DESIGN.md, "Clipboard"): Cmd-V text goes through
 * xterm's bracketed paste, so a multi-line paste never submits early. An image
 * with no text is saved and its path typed. Ctrl-V reaches the agent as ^V
 * (Claude Code reads the clipboard image itself).
 */
export default function TerminalPane({ id, active }: { id: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const resend = useRef<() => void>(() => {});
  const [ended, setEnded] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const t = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      scrollback: 10000,
      macOptionIsMeta: true,
      theme: theme(element),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = '11';
    t.open(element);
    term.current = t; fit.current = f;
    try { f.fit(); } catch { /* not laid out yet */ }

    let view: number | null = null;
    let disposed = false;
    // The agent must end up with the size the screen has. Sizes are sent one
    // at a time, newest last: two requests in flight can arrive in the wrong
    // order, and an agent that draws for another width than the screen's
    // garbles every repaint until the next resize.
    let wanted: { cols: number; rows: number } | null = null;
    let sending = false;
    const sendSize = async (cols: number, rows: number) => {
      wanted = { cols, rows };
      if (sending) return;
      sending = true;
      try {
        const take = () => { const next = wanted; wanted = null; return next; };
        for (let next = take(); next && !disposed; next = take()) {
          await harnessApi.resize(id, next.cols, next.rows).catch(() => {});
        }
      } finally { sending = false; }
    };
    resend.current = () => { void sendSize(t.cols, t.rows); };
    harnessApi.attach(id, bytes => {
      if (bytes.length === 0) { setEnded(true); return; }
      t.write(bytes);
    }).then(handle => {
      if (disposed) { void harnessApi.detach(handle); return; }
      view = handle;
      void sendSize(t.cols, t.rows);
    }).catch(e => setNotice(err(e)));

    const typed = t.onData(data => { if (view !== null) harnessApi.input(view, data).catch(e => setNotice(err(e))); });
    const resized = t.onResize(({ cols, rows }) => { void sendSize(cols, rows); });

    const onPaste = (e: ClipboardEvent) => {
      const image = pastedImage(e.clipboardData);
      if (!image) return;
      e.preventDefault(); e.stopPropagation();
      image.arrayBuffer()
        .then(bytes => harnessApi.saveImage(id, bytes))
        .then(path => t.paste(`${shellQuote(path)} `))
        .catch(error => setNotice(`Image paste failed: ${err(error)}`));
    };
    // Capture phase: before xterm's own textarea handler pastes nothing
    element.addEventListener('paste', onPaste, true);

    // Fit once the size has settled. Every new size reaches the agent as a
    // window change, and Claude Code and Codex repaint their whole transcript
    // for each one: fitting on every frame of a window drag floods the
    // terminal with repaints that keep flickering long after the drag.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(() => { try { f.fit(); } catch { /* hidden */ } }, RESIZE_SETTLE_MS);
    });
    observer.observe(element);
    return () => {
      disposed = true;
      clearTimeout(settle);
      observer.disconnect();
      element.removeEventListener('paste', onPaste, true);
      typed.dispose(); resized.dispose();
      if (view !== null) void harnessApi.detach(view);
      t.dispose();
      term.current = null; fit.current = null; resend.current = () => {};
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    // Shown again: fit, and tell the agent the size even when it did not change here
    // (the session may have been resized from elsewhere while this pane was hidden)
    requestAnimationFrame(() => { try { fit.current?.fit(); } catch { /* hidden */ } resend.current(); term.current?.focus(); });
  }, [active]);

  return <div className="hs-terminal-wrap">
    <div className="hs-terminal-pad"><div className="hs-terminal" ref={host} onClick={() => term.current?.focus()} /></div>
    {(ended || notice) && <div className="hs-terminal-notice" role="status">{notice || 'The session ended. Its output is kept until you forget it.'}</div>}
  </div>;
}
