// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

it('xterm sends CR for Enter and ESC CR for Alt+Enter after keyboard mode requests', async () => {
  const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof import('@xterm/xterm');
  const host = document.body.appendChild(document.createElement('div'));
  const term = new Terminal({ macOptionIsMeta: true });
  try {
    term.open(host);
    const sent: string[] = [];
    term.onData(data => sent.push(data));
    for (const mode of ['', '\x1b[>1u', '\x1b[=1u', '\x1b[>4;2m']) {
      await new Promise<void>(resolve => term.write(mode, resolve));
      sent.length = 0;
      for (const altKey of [false, true]) {
        const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', altKey, bubbles: true, cancelable: true });
        Object.defineProperty(enter, 'keyCode', { value: 13 });
        term.textarea!.dispatchEvent(enter);
      }
      expect(sent).toEqual(['\r', '\x1b\r']);
    }
  } finally {
    term.dispose();
    host.remove();
  }
});
