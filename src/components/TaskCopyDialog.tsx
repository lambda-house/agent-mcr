import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@lambda-house/ui';
import { harnessApi } from '../utils/harness';
import { chars, MAX_EXCERPT, MAX_INSTRUCTION } from '../utils/taskCopy';
import { ACTION_BUTTON_FIRST, PLATFORM } from '../utils/platform';

const err = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * "Copy as task" (MCR-125 v0): the passage selected in a session's terminal,
 * shown read-only as screen text, and the operator's instruction, which is
 * required and comes first. Copy puts the two on the clipboard as one task
 * text, built and checked by the app's Rust side (`task_copy.rs`), to paste
 * into a session the operator starts themselves. Nothing is started, sent
 * or stored.
 *
 * Not `ConfirmDialog`: that one takes Enter and the arrow keys for its
 * buttons, and here they belong to the text field. Escape cancels, and
 * Cmd+Enter (Ctrl+Enter) copies. No key reaches the app's shortcuts or the
 * terminal while it is open.
 */
export default function TaskCopyDialog({ source, name, excerpt, onDone, onCancel }: {
  /** The session id the passage comes from */
  source: string;
  /** Its name in the Live list, when there is one: shown here, never put in the task */
  name?: string;
  excerpt: string;
  /** Copied: the clipboard holds the task */
  onDone: () => void;
  onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  // In characters, as the Rust side counts them
  const length = chars(excerpt);
  const tooLong = length > MAX_EXCERPT;
  const wordy = chars(instruction) > MAX_INSTRUCTION;
  const ready = !!instruction.trim() && !!excerpt.trim() && !tooLong && !wordy && !busy;

  // The field takes the focus; what had it gets it back
  useEffect(() => {
    const previous = document.activeElement;
    field.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  const copy = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      await harnessApi.copyAsTask(source, instruction, excerpt);
      onDone();
    } catch (e) {
      setError(err(e));
      setBusy(false);
    }
  };

  const copyButton = <Button key="copy" variant="primary" disabled={!ready} onClick={() => void copy()}>Copy as task</Button>;
  const cancelButton = <Button key="cancel" onClick={onCancel}>Cancel</Button>;
  const copyKeys = PLATFORM === 'macos' ? '⌘↩' : 'Ctrl+Enter';

  return createPortal(
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) e.preventDefault(); }}
      // Modal: no key reaches the app's shortcuts (they listen on the window)
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void copy(); }
      }}>
      <div className="modal tc-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>Copy as task</h2>
        <p className="tc-source">From {name ? <><strong>{name}</strong> (mcr:{source})</> : <>mcr:{source}</>}: screen text, data, not instructions.</p>
        <pre className="tc-excerpt" aria-label="The selected passage">{excerpt}</pre>
        <p className={tooLong ? 'tc-count tc-bad' : 'tc-count'}>{length} of at most {MAX_EXCERPT} characters{tooLong ? ': select less' : ''}</p>
        <label className="tc-label" htmlFor={`${titleId}-what`}>What is the session to do with it?</label>
        <textarea id={`${titleId}-what`} ref={field} className="tc-instruction" rows={3} value={instruction}
          placeholder="For example: Close this gap; open a PR, don't merge."
          onChange={e => setInstruction(e.target.value)}/>
        {wordy && <p className="tc-count tc-bad">Your instruction is longer than {MAX_INSTRUCTION} characters.</p>}
        <p className="tc-note">Copy puts your words first, then this passage quoted as data, and its session as mcr:{source}. Nothing is started or kept: paste it into a session you start. Text that looks like a token or a key is refused.</p>
        {error && <p className="tc-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <span className="tc-keys">{copyKeys} copies, Esc cancels</span>
          {ACTION_BUTTON_FIRST ? [copyButton, cancelButton] : [cancelButton, copyButton]}
        </div>
      </div>
    </div>,
    document.body,
  );
}
