import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { harnessApi, pastedImage, SESSION_DRAG_TYPE, sessionLinks, shellQuote } from '../utils/harness';
import { isPaletteKey, PLATFORM } from '../utils/platform';

/** How long the pane's size must stay the same before the terminal is fitted to it. */
export const RESIZE_SETTLE_MS = 200;
/**
 * A session that ends this soon after a key press in its terminal was quit by
 * the person (Ctrl-D twice, /exit): it leaves the list like a closed one. One
 * that ends on its own stays, with its output, until it is removed.
 */
export const QUIT_WINDOW_MS = 10_000;

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
export default function TerminalPane({ id, active, onQuit, isSession, onSession, focusAt }: {
  id: string; active: boolean;
  /** The session ended right after the person pressed keys in it: they quit the agent themselves */
  onQuit?: () => void;
  /** Whether an id is a session the app can show: `mcr:<id>` in the output is then a link */
  isSession?: (id: string) => boolean;
  /** A click on such a link */
  onSession?: (id: string) => void;
  /** Changes when this terminal is to take the keyboard, as after a click on a link to its session */
  focusAt?: number;
}) {
  const quit = useRef(onQuit);
  quit.current = onQuit;
  const sessions = useRef({ isSession, onSession });
  sessions.current = { isSession, onSession };
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
    // The command panel's key is the app's: xterm would send Ctrl+Shift+P to the agent as Ctrl+P
    t.attachCustomKeyEventHandler(e => !isPaletteKey(e, PLATFORM));
    term.current = t; fit.current = f;
    // A session pointer in the output is a link to that session (MCR-82)
    const links = t.registerLinkProvider({
      provideLinks(y, done) {
        const line = t.buffer.active.getLine(y - 1);
        const known = sessions.current.isSession;
        if (!line || !known) return done(undefined);
        // The column of every character: a wide one takes two cells, and the second holds nothing
        let text = '';
        const columns: number[] = [];
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          for (let i = 0; i < chars.length; i++) columns.push(x);
          text += chars;
        }
        const found = sessionLinks(text, known).map(link => ({
          range: { start: { x: columns[link.start] + 1, y }, end: { x: columns[link.end - 1] + 1, y } },
          text: text.slice(link.start, link.end),
          activate: () => sessions.current.onSession?.(link.id),
        }));
        done(found.length ? found : undefined);
      },
    });
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
    // Key presses only: xterm's own replies to the agent's queries are not the person
    let lastKey = 0;
    const keyed = t.onKey(() => { lastKey = Date.now(); });
    harnessApi.attach(id, bytes => {
      if (bytes.length === 0) {
        setEnded(true);
        if (Date.now() - lastKey < QUIT_WINDOW_MS) quit.current?.();
        return;
      }
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

    // A session row dropped here: its reference is typed at the prompt, like a paste
    const dragged = (e: DragEvent) => !!e.dataTransfer?.types.includes(SESSION_DRAG_TYPE);
    const onDragOver = (e: DragEvent) => { if (dragged(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } };
    const onDrop = (e: DragEvent) => {
      if (!dragged(e)) return;
      e.preventDefault(); e.stopPropagation();
      const reference = e.dataTransfer?.getData('text/plain');
      // Typed tasks are checked for a leading !, # or /; this always starts with the pointer
      if (reference?.startsWith('mcr:')) { t.paste(`${reference} `); t.focus(); }
    };
    element.addEventListener('dragover', onDragOver, true);
    element.addEventListener('drop', onDrop, true);

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
      element.removeEventListener('dragover', onDragOver, true);
      element.removeEventListener('drop', onDrop, true);
      typed.dispose(); keyed.dispose(); resized.dispose(); links.dispose();
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

  useEffect(() => {
    if (!focusAt) return;
    // After the click that asked for it: that click leaves the keyboard in the terminal it was made in
    const frame = requestAnimationFrame(() => term.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusAt]);

  return <div className="hs-terminal-wrap">
    <div className="hs-terminal-pad"><div className="hs-terminal" ref={host} onClick={() => term.current?.focus()} /></div>
    {(ended || notice) && <div className="hs-terminal-notice" role="status">{notice || 'The session ended. Its output is kept until you forget it.'}</div>}
  </div>;
}
