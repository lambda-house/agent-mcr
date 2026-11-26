import { useEffect, useRef, useState } from 'react';
import { Terminal, type IDecoration, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { harnessApi, pastedImage, pointerSpans, SESSION_DRAG_TYPE, shellQuote, type TerminalCell } from '../utils/harness';
import { isPaletteKey, PLATFORM } from '../utils/platform';
import { excerptFromSelection } from '../utils/taskCopy';
import { isCopyKey, isTaskKey, terminalTask, type TerminalTask } from '../utils/terminalTask';
import TaskCopyDialog from './TaskCopyDialog';
import { cancelBanner, useBannerIntent } from '../utils/bannerIntent';
import { MAX_KEPT, TerminalKeep } from '../utils/terminalKeep';
import { disableOutputScrollbarReveal, tryWebgl } from '../utils/terminalRenderer';

/** How long the pane's size must stay the same before the terminal is fitted to it. */
export const RESIZE_SETTLE_MS = 200;
/**
 * A session that ends this soon after a key press in its terminal was quit by
 * the person (Ctrl-D twice, /exit): it leaves the list like a closed one. One
 * that ends on its own stays, with its output, until it is removed.
 */
export const QUIT_WINDOW_MS = 10_000;

const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const INPUT_DROPPED_NOTICE = 'Terminal input was dropped. Check the prompt and retype the lost keys.';

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

/** Hidden terminals kept with what they showed (MCR-139); see utils/terminalKeep.ts */
export const keep = new TerminalKeep<{ term: Terminal; fit: FitAddon }>(MAX_KEPT, ({ term }) => term.dispose());

type ViewReceiver = {
  start: (from: number | null) => void;
  data: (bytes: Uint8Array) => void;
  ready: () => void;
  error: (error: unknown) => void;
};

/** The runner view can outlive the terminal that first asked for it. */
class TerminalView {
  handle: number | null = null;
  private receiver?: ViewReceiver;
  private from?: number | null;
  private queued: Uint8Array[] = [];
  private closed = false;

  listen(receiver: ViewReceiver) {
    this.receiver = receiver;
    if (this.from !== undefined) receiver.start(this.from);
    if (this.receiver !== receiver) return;
    if (this.handle !== null) receiver.ready();
    const queued = this.queued;
    this.queued = [];
    for (const bytes of queued) receiver.data(bytes);
  }

  pause() { this.receiver = undefined; }

  open(id: string, since: number | null) {
    void harnessApi.attach(id, since, {
      start: from => {
        if (this.closed) return;
        this.from = from;
        this.receiver?.start(from);
      },
      data: bytes => {
        if (this.closed) return;
        if (this.receiver) this.receiver.data(bytes);
        else this.queued.push(bytes);
      },
    }).then(handle => {
      if (this.closed) { void harnessApi.detach(handle); return; }
      this.handle = handle;
      this.receiver?.ready();
    }).catch(error => this.receiver?.error(error));
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.pause();
    this.queued = [];
    if (this.handle !== null) void harnessApi.detach(this.handle);
  }
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
export default function TerminalPane({ id, name, active, focusOnMount = false, onQuit, isSession, onSession, focusAt, onFocused, passive = false, onActive }: {
  id: string; active: boolean;
  /** The selected pane may take the keyboard when it mounts. */
  focusOnMount?: boolean;
  /** Its name in the Live list, for the Copy as task dialog (MCR-125) */
  name?: string;
  /** The session ended right after the person pressed keys in it: they quit the agent themselves */
  onQuit?: () => void;
  /** Whether an id is a session the app can show: `mcr:<id>` in the output is then a link */
  isSession?: (id: string) => boolean;
  /** A click on such a link */
  onSession?: (id: string) => void;
  /** Changes when this terminal is to take the keyboard, as after a click on a link to its session */
  focusAt?: number;
  /** It took the keyboard for `focusAt`: the request is served and must not be handed to a later mount */
  onFocused?: () => void;
  /**
   * While a clicked banner's ask is pending, and for the view it showed
   * (MCR-180): nothing goes from this view to the session, not even the focus
   * reports xterm sends by itself, until the operator clicks or types in it.
   * Then `onActive`
   */
  passive?: boolean;
  onActive?: () => void;
}) {
  const quit = useRef(onQuit);
  quit.current = onQuit;
  const sessions = useRef({ isSession, onSession, onFocused, onActive });
  sessions.current = { isSession, onSession, onFocused, onActive };
  // Once the operator gave this view the keyboard it is theirs, whatever a render still says
  const activated = useRef(false);
  // A later banner that shows this view again makes it passive again
  const wasPassive = useRef(passive);
  if (passive && !wasPassive.current) activated.current = false;
  wasPassive.current = passive;
  const passiveNow = useRef(passive);
  passiveNow.current = passive && !activated.current;
  /**
   * Whether nothing may leave this view (MCR-180): it is passive, or a banner's ask is pending,
   * read from the store at the moment of leaving, not from a render. Asked at the two places
   * where anything leaves a terminal: the keyboard (`focusTerm`) and the input to the session
   * (`flushInput`, and `onData` before it queues)
   */
  const held = () => passiveNow.current || useBannerIntent.getState().intent !== null;
  const focusTerm = (t: Terminal | null) => { if (t && !held()) t.focus(); };
  // Looks at the pointers on screen again (MCR-106)
  const pointers = useRef<() => void>(() => {});
  const host = useRef<HTMLDivElement>(null);
  // The operator's own pointer or key in a passive view makes it theirs: captured before
  // xterm's handlers, so the key itself and the focus report of their click go out.
  // Not a focus event: a window coming forward focuses the terminal that had the keyboard
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const take = () => {
      if (!held()) return;
      activated.current = true;
      passiveNow.current = false;
      // The operator's own choice: a banner's ask still pending gives way to it
      cancelBanner();
      sessions.current.onActive?.();
    };
    const events = ['pointerdown', 'mousedown', 'keydown', 'drop'] as const;
    events.forEach(e => element.addEventListener(e, take, true));
    return () => events.forEach(e => element.removeEventListener(e, take, true));
  }, []);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const resend = useRef<() => void>(() => {});
  const [ended, setEnded] = useState(false);
  // A kept terminal the runner could not go on with is let go, and the pane mounts a new one (review 17088)
  const [fresh, setFresh] = useState(0);
  const replacement = useRef<{ id: string; view: TerminalView } | null>(null);
  // The terminal let go had the keyboard: the new one takes it (review 17090)
  const refocus = useRef(false);
  const pendingEnter = useRef<{ id: string; retry: boolean } | null>(null);
  // Keep track across a view replacement: the next Enter may belong to lost keys.
  const inputLost = useRef(false);
  const [notice, setNotice] = useState('');
  // Copy as task (MCR-125 v0): the right-click menu on a selection, and the dialog with its passage
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const [task, setTask] = useState<string | null>(null);
  const say = (text: string) => { setNotice(text); setTimeout(() => setNotice(n => n === text ? '' : n), 4000); };
  const openTask = (selection: string) => {
    setMenu(null);
    const excerpt = excerptFromSelection(selection);
    if (excerpt.trim()) setTask(excerpt);
    else say('Nothing to copy as a task: the selection holds only the frame the agent draws.');
  };
  const opener = useRef(openTask);
  opener.current = openTask;
  // Only a terminal that is shown answers the app's command: never one left behind in another pane
  const shown = useRef(active);
  shown.current = active;
  const takeFocus = useRef(focusOnMount);
  takeFocus.current = focusOnMount;
  const copyText = (text: string) => { harnessApi.copyText(text).catch(e => setNotice(err(e))); };

  useEffect(() => () => {
    if (pendingEnter.current?.id === id) pendingEnter.current = null;
    inputLost.current = false;
    if (replacement.current?.id === id) {
      replacement.current.view.dispose();
      replacement.current = null;
    }
  }, [id]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // A session shown a moment ago comes back with the terminal it had: every
    // line it showed, and only what it missed from the runner (MCR-139)
    const kept = keep.take(id);
    let t: Terminal, f: FitAddon;
    if (kept) {
      ({ term: t, fit: f } = kept.term);
      if (t.element) element.appendChild(t.element);
    } else {
      t = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: '"SF Mono", Menlo, Monaco, monospace',
        fontSize: 13,
        scrollback: 10000,
        macOptionIsMeta: true,
        theme: theme(element),
      });
      f = new FitAddon();
      t.loadAddon(f);
      t.loadAddon(new Unicode11Addon());
      t.unicode.activeVersion = '11';
      t.open(element);
      disableOutputScrollbarReveal(t);
    }
    if (refocus.current) {
      refocus.current = false;
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (shown.current && !document.hidden && term.current === t && (!focused || focused === document.body || !focused.isConnected)) focusTerm(t);
      });
    }
    // The command panel's key is the app's: xterm would send Ctrl+Shift+P to the agent as Ctrl+P.
    // So is Copy as task's (MCR-125): Ctrl+Shift+C would reach the agent as Ctrl+C and stop its turn
    // On Windows and Linux Ctrl+Shift+C copies the selection, as in other terminals, and is never the agent's
    t.attachCustomKeyEventHandler(e => {
      if (isPaletteKey(e, PLATFORM) || isTaskKey(e)) return false;
      if (isCopyKey(e)) {
        if (e.type === 'keydown' && t.hasSelection()) copyText(t.getSelection());
        return false;
      }
      return true;
    });
    // The terminal that last had the keyboard answers the app's Copy as task command, while it is shown
    const mine: TerminalTask = { hasSelection: () => shown.current && t.hasSelection() && !!t.getSelection().trim(), open: () => opener.current(t.getSelection()) };
    const claim = () => { terminalTask.current = mine; };
    t.textarea?.addEventListener('focus', claim);
    term.current = t; fit.current = f;
    // A session pointer in the output is a link to that session (MCR-82).
    // A line the terminal wrapped is read whole, so a pointer cut by the wrap is one link
    const buffer = () => t.buffer.active;
    const cellsOf = (y: number): TerminalCell[] => {
      const line = buffer().getLine(y);
      const cells: TerminalCell[] = [];
      for (let x = 0; line && x < line.length; x++) {
        const cell = line.getCell(x);
        cells.push({ chars: cell?.getChars() ?? '', width: cell?.getWidth() ?? 1 });
      }
      return cells;
    };
    // The rows of the line that row `y` (0-based, in the buffer) belongs to
    const lineAt = (y: number) => {
      let first = y;
      while (first > 0 && buffer().getLine(first)?.isWrapped) first--;
      let last = y;
      while (buffer().getLine(last + 1)?.isWrapped) last++;
      // Most lines hold no pointer: their text, asked of xterm as one string,
      // says so without reading them cell by cell (a cell is an object each time)
      let text = '';
      for (let row = first; row <= last; row++) text += buffer().getLine(row)?.translateToString(false) ?? '';
      const rows: TerminalCell[][] = [];
      if (text.includes('mcr:')) for (let row = first; row <= last; row++) rows.push(cellsOf(row));
      return { first, last, rows };
    };
    const links = t.registerLinkProvider({
      provideLinks(y, done) {
        const known = sessions.current.isSession;
        if (!known || !buffer().getLine(y - 1)) return done(undefined);
        const { first, rows } = lineAt(y - 1);
        const found = pointerSpans(rows, known)
          .filter(p => p.cells.some(c => first + c.row === y - 1))
          .map(p => {
            const start = p.cells[0], end = p.cells[p.cells.length - 1];
            return {
              // Columns and rows are 1-based; the end is the pointer's last cell
              range: { start: { x: start.x + 1, y: first + start.row + 1 }, end: { x: end.x + end.width, y: first + end.row + 1 } },
              text: p.text,
              activate: () => sessions.current.onSession?.(p.id),
            };
          });
        done(found.length ? found : undefined);
      },
    });
    // xterm underlines a link only under the mouse. So that a pointer is seen
    // to be one (MCR-106), each is underlined all the time by a decoration:
    // an element over its cells that takes no pointer events and holds no
    // text, so the cells, the selection, what is copied and the click are
    // xterm's as before. The rows that are drawn are looked at again on every
    // render, so a line rewritten in place or a session that ended loses it.
    type Mark = { marker: IMarker; decoration: IDecoration; x: number; width: number; id: string };
    let marks: Mark[] = [];
    const unmark = (m: Mark) => { marks = marks.filter(other => other !== m); m.decoration.dispose(); m.marker.dispose(); };
    const mark = (row: number, x: number, width: number, id: string) => {
      const marker = t.registerMarker(row - (buffer().baseY + buffer().cursorY));
      if (!marker) return;
      const decoration = t.registerDecoration({ marker, x, width, layer: 'top' });
      if (!decoration) { marker.dispose(); return; }
      decoration.onRender(element => element.classList.add('hs-pointer'));
      const m = { marker, decoration, x, width, id };
      marks.push(m);
      // The row left the scrollback
      marker.onDispose(() => { if (marks.includes(m)) unmark(m); });
    };
    const remark = (start: number, end: number) => {
      // xterm draws no decoration while the other screen buffer is active (a
      // full-screen program): marks made there would not be seen. The link and
      // its underline under the mouse work there all the same
      if (buffer().type === 'alternate') return;
      const known = sessions.current.isSession;
      const looked = new Set<number>();
      for (let row = start; row <= end; row++) {
        const y = buffer().viewportY + row;
        if (looked.has(y) || !buffer().getLine(y)) continue;
        const { first, last, rows } = lineAt(y);
        for (let r = first; r <= last; r++) looked.add(r);
        const want = known ? pointerSpans(rows, known).flatMap(p => p.cells.map(c => ({ row: first + c.row, x: c.x, width: c.width, id: p.id }))) : [];
        const same = (m: Mark, w: (typeof want)[number]) => m.marker.line === w.row && m.x === w.x && m.width === w.width && m.id === w.id;
        const have = marks.filter(m => m.marker.line >= first && m.marker.line <= last);
        have.filter(m => !want.some(w => same(m, w))).forEach(unmark);
        want.filter(w => !have.some(m => same(m, w))).forEach(w => mark(w.row, w.x, w.width, w.id));
      }
    };
    const rendered = t.onRender(({ start, end }) => remark(start, end));
    // Marks belong to the buffer they were made in: the other one starts clean
    const switched = t.buffer.onBufferChange(() => { [...marks].forEach(unmark); remark(0, t.rows - 1); });
    // A new width rewraps the lines and moves their cells, also in the
    // scrollback: every mark is dropped, the rows in view are marked again at
    // once, and the others when they are drawn
    const reflowed = t.onResize(() => { [...marks].forEach(unmark); remark(0, t.rows - 1); });
    // The marks are drawn over the cells, so looking again needs no repaint
    pointers.current = () => remark(0, t.rows - 1);
    try { f.fit(); } catch { /* not laid out yet */ }

    const transferred = replacement.current?.id === id ? replacement.current.view : null;
    if (transferred) replacement.current = null;
    const view = transferred ?? new TerminalView();
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
    // Where the terminal is in the session's output: the offset of the next byte it has not seen
    let offset: number | null = kept?.offset ?? null;
    // This terminal is not to be kept or used again: the runner could not go on where it left off
    let discard = false;
    let reconnecting = false;
    let writingInput = false;
    const inputQueue: { handle: number; data: string; retry: boolean }[] = [];
    const loseInput = () => {
      inputLost.current = true;
      pendingEnter.current = null;
    };
    const dropInput = (data: string) => {
      if (data === '\r') {
        // This Enter belonged to the lost keys. The next one can submit again.
        inputLost.current = false;
      } else {
        loseInput();
        setNotice(INPUT_DROPPED_NOTICE);
      }
    };
    const flushInput = async () => {
      if (writingInput) return;
      writingInput = true;
      try {
        // Process even dropped input in order so its Enter ends the sequence.
        for (let next = inputQueue.shift(); next && !disposed; next = inputQueue.shift()) {
          const { handle, data, retry } = next;
          const enter = data === '\r';
          if (discard || reconnecting || (enter && inputLost.current)) {
            dropInput(data);
            continue;
          }
          // Nothing leaves while held, also what was queued before (MCR-180): a focus report
          // queued behind a key would otherwise go out once that key is written
          if (held()) continue;
          try {
            await harnessApi.input(handle, data);
            if (enter && !disposed) setNotice(n => n === INPUT_DROPPED_NOTICE ? '' : n);
          } catch (error) {
            if (disposed) return;
            const message = err(error);
            if (!enter) loseInput();
            if (!discard && retry && message.startsWith('The terminal is detached') && shown.current) {
              reconnecting = true;
              refocus.current = !!document.activeElement && !!t.element?.contains(document.activeElement);
              if (enter) {
                pendingEnter.current = { id, retry: false };
                continue;
              }
            }
            setNotice(message);
          }
        }
      } finally {
        writingInput = false;
        if (!disposed && (discard || reconnecting)) setFresh(n => n + 1);
      }
    };
    const sendInput = (handle: number, data: string, retry: boolean) => {
      inputQueue.push({ handle, data, retry });
      void flushInput();
    };
    view.listen({
      start: from => {
        // The runner could not start where this terminal left off (it holds no
        // more, or it is a runner that does not say). The terminal is not reset
        // and reused: a reset leaves xterm's parser inside any sequence the last
        // bytes left unfinished, and the replay's first bytes were read as its
        // end ("ew line", review 17088). Pass this view and its replay to a new
        // terminal, including any frames that arrive before React replaces it.
        if (kept && (from === null || from !== kept.offset)) {
          discard = true;
          refocus.current = !!document.activeElement && !!t.element?.contains(document.activeElement);
          view.pause();
          replacement.current = { id, view };
          // Account for the in-flight write before dropping the queued keys.
          if (!writingInput) setFresh(n => n + 1);
          return;
        }
        offset = from;
      },
      data: bytes => {
        if (disposed || discard) return;
        if (bytes.length === 0) {
          setEnded(true);
          if (Date.now() - lastKey < QUIT_WINDOW_MS) quit.current?.();
          return;
        }
        t.write(bytes);
        if (offset !== null) offset += bytes.length;
      },
      ready: () => {
        const enter = pendingEnter.current;
        if (enter?.id === id && view.handle !== null) {
          pendingEnter.current = null;
          if (shown.current) sendInput(view.handle, '\r', enter.retry);
        }
        void sendSize(t.cols, t.rows);
      },
      error: e => {
        if (pendingEnter.current?.id === id) pendingEnter.current = null;
        setNotice(err(e));
      },
    });
    if (!transferred) view.open(id, offset);

    const typed = t.onData(data => {
      if (disposed) return;
      // Held: the terminal's own answers and reports are dropped, never typed into the agent
      if (held()) return;
      if (view.handle !== null && ((!discard && !reconnecting) || (shown.current && writingInput))) {
        sendInput(view.handle, data, true);
      } else if (shown.current) {
        if (data === '\r' && !discard && !reconnecting && !inputLost.current) {
          pendingEnter.current = { id, retry: true };
        } else dropInput(data);
      }
    });
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

    // A right click on a selection offers Copy and Copy as task. Taken before
    // xterm's own handler, which would select the word under the pointer; a
    // right click without a selection is xterm's as before
    const onContextMenu = (e: MouseEvent) => {
      const text = t.hasSelection() ? t.getSelection() : '';
      if (!text.trim()) return;
      e.preventDefault(); e.stopPropagation();
      setMenu({ x: Math.min(e.clientX, window.innerWidth - 190), y: Math.min(e.clientY, window.innerHeight - 80), text });
    };
    element.addEventListener('contextmenu', onContextMenu, true);

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
      // A hidden pane gives up its handle. Drop bytes that have yet to be sent.
      inputQueue.length = 0;
      clearTimeout(settle);
      observer.disconnect();
      element.removeEventListener('paste', onPaste, true);
      element.removeEventListener('dragover', onDragOver, true);
      element.removeEventListener('drop', onDrop, true);
      element.removeEventListener('contextmenu', onContextMenu, true);
      t.textarea?.removeEventListener('focus', claim);
      if (terminalTask.current === mine) terminalTask.current = null;
      typed.dispose(); keyed.dispose(); resized.dispose(); links.dispose(); rendered.dispose(); switched.dispose(); reflowed.dispose();
      // The marks are this mount's: the next one marks the rows it draws
      [...marks].forEach(unmark);
      pointers.current = () => {};
      if (replacement.current?.view !== view) view.dispose();
      // Kept, not disposed: shown again it takes only what it missed
      t.element?.remove();
      // The same xterm retains its pending writes. A quick reattach can append
      // the continuation behind them without waiting for the parser or replaying.
      if (discard) t.dispose();
      else keep.put(id, { term: { term: t, fit: f }, offset });
      term.current = null; fit.current = null; resend.current = () => {};
    };
  }, [id, fresh]);

  useEffect(() => {
    // WebGL uses more memory in the Mac demos. Enable it on a trial build
    // with VITE_TERMINAL_WEBGL=1.
    if (active && term.current && import.meta.env.VITE_TERMINAL_WEBGL === '1') return tryWebgl(term.current);
  }, [active, id, fresh]);

  // A session that started or ended changes which pointers are links
  useEffect(() => { pointers.current(); }, [isSession]);

  useEffect(() => {
    if (!active) return;
    // Shown again: fit, and tell the agent the size even when it did not change here
    // (the session may have been resized from elsewhere while this pane was hidden)
    const frame = requestAnimationFrame(() => {
      if (document.hidden || !term.current) return;
      try { fit.current?.fit(); } catch { /* hidden */ }
      resend.current();
      term.current.refresh(0, term.current.rows - 1);
      if (takeFocus.current) focusTerm(term.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, id]);

  useEffect(() => {
    if (!focusAt) return;
    // After the click that asked for it: that click leaves the keyboard in the terminal it was made in
    const frame = requestAnimationFrame(() => { focusTerm(term.current); sessions.current.onFocused?.(); });
    return () => cancelAnimationFrame(frame);
  }, [focusAt]);

  // The menu closes on a click elsewhere and on Escape
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', key); window.addEventListener('blur', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); window.removeEventListener('blur', close); };
  }, [menu]);

  const copied = () => { setTask(null); say('Copied as a task: paste it into the session that is to do it.'); };

  return <div className="hs-terminal-wrap">
    <div className="hs-terminal-pad"><div className="hs-terminal" ref={host} onClick={() => term.current?.focus()} /></div>
    {(ended || notice) && <div className="hs-terminal-notice" role="status">{notice || 'The session ended.'}</div>}
    {menu && <div className="hs-menu tc-menu" role="menu" style={{ top: menu.y, left: menu.x }} onMouseDown={e => e.stopPropagation()}>
      <button type="button" role="menuitem" onClick={() => { const text = menu.text; setMenu(null); copyText(text); }}>Copy</button>
      <button type="button" role="menuitem" autoFocus onClick={() => openTask(menu.text)}>Copy as task…</button>
    </div>}
    {task !== null && <TaskCopyDialog source={id} name={name} excerpt={task} onDone={copied} onCancel={() => setTask(null)}/>}
  </div>;
}
