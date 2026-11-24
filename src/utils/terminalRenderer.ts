import type { IDisposable, Terminal } from '@xterm/xterm';
import type { WebglAddon } from '@xterm/addon-webgl';

/** Try WebGL on a shown terminal. Disposing the addon restores xterm's DOM renderer. */
export function tryWebgl(terminal: Terminal): () => void {
  let stopped = false;
  let addon: WebglAddon | undefined;
  let loss: IDisposable | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let context: WebGL2RenderingContext | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    canvas?.removeEventListener('webglcontextlost', stop, true);
    loss?.dispose();
    try { addon?.dispose(); }
    finally {
      // xterm removes its canvas and deletes its atlas, but does not explicitly
      // release the context. Do so after it has removed its restoration listener.
      if (context && !context.isContextLost()) context.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };

  void import('@xterm/addon-webgl').then(({ WebglAddon }) => {
    if (stopped) return;
    const screen = terminal.element?.querySelector('.xterm-screen');
    const before = new Set(screen?.querySelectorAll('canvas'));
    addon = new WebglAddon();
    loss = addon.onContextLoss(stop);
    terminal.loadAddon(addon);
    for (const added of screen?.querySelectorAll('canvas') ?? []) {
      if (before.has(added)) continue;
      context = added.getContext('webgl2');
      if (context) {
        canvas = added;
        // Switch back immediately rather than waiting for xterm's restoration timeout.
        canvas.addEventListener('webglcontextlost', stop, true);
        break;
      }
    }
  }).catch(stop);

  return stop;
}
