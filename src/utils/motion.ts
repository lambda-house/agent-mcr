/** The class on the root element while the window is in the background (harness.css pauses every animation under it). */
export const INACTIVE_CLASS = 'app-inactive';

/**
 * Marks the root element while the window has no focus or is hidden, so that
 * no animation repaints a window nobody looks at (MCR-139). Returns the undo.
 */
export function watchWindowActivity(win: Window = window): () => void {
  const doc = win.document;
  // A blur or focus event says it itself: hasFocus() may still give the state before it
  const set = (e?: Event) => doc.documentElement.classList.toggle(INACTIVE_CLASS,
    doc.hidden || e?.type === 'blur' || (e?.type !== 'focus' && !doc.hasFocus()));
  set();
  win.addEventListener('focus', set);
  win.addEventListener('blur', set);
  doc.addEventListener('visibilitychange', set);
  return () => {
    win.removeEventListener('focus', set);
    win.removeEventListener('blur', set);
    doc.removeEventListener('visibilitychange', set);
    doc.documentElement.classList.remove(INACTIVE_CLASS);
  };
}
