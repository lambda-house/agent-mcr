// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { tryWebgl } from './terminalRenderer';

const renderer = vi.hoisted(() => ({
  lost: undefined as (() => void) | undefined,
  dispose: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {
  onContextLoss(callback: () => void) { renderer.lost = callback; return { dispose: renderer.unsubscribe }; }
  dispose = renderer.dispose;
} }));

const loaded = () => vi.dynamicImportSettled();
function terminal(unavailable = false) {
  const element = document.createElement('div');
  const screen = element.appendChild(document.createElement('div'));
  screen.className = 'xterm-screen';
  const loseContext = vi.fn();
  const loadAddon = vi.fn(() => {
    if (unavailable) throw new Error('WebGL2 not supported');
    const canvas = screen.appendChild(document.createElement('canvas'));
    vi.spyOn(canvas, 'getContext').mockReturnValue({ isContextLost: () => false, getExtension: () => ({ loseContext }) } as unknown as WebGL2RenderingContext);
  });
  return { term: { element, loadAddon } as unknown as Terminal, screen, loadAddon, loseContext };
}

beforeEach(() => { vi.clearAllMocks(); renderer.lost = undefined; });

it('disposes the addon on context loss and releases its canvas context once', async () => {
  const { term, loadAddon, loseContext } = terminal();
  const stop = tryWebgl(term);
  await loaded();
  expect(loadAddon).toHaveBeenCalledOnce();
  renderer.lost?.();
  stop();
  expect(renderer.unsubscribe).toHaveBeenCalledOnce();
  expect(renderer.dispose).toHaveBeenCalledOnce();
  expect(loseContext).toHaveBeenCalledOnce();
  expect(renderer.dispose.mock.invocationCallOrder[0]).toBeLessThan(loseContext.mock.invocationCallOrder[0]);
});

it('releases a working context when the pane goes away', async () => {
  const { term, loseContext } = terminal();
  const stop = tryWebgl(term);
  await loaded();
  stop();
  expect(renderer.dispose).toHaveBeenCalledOnce();
  expect(loseContext).toHaveBeenCalledOnce();
});

it('falls back immediately on the canvas context-loss event', async () => {
  const { term, screen } = terminal();
  tryWebgl(term);
  await loaded();
  screen.querySelector('canvas')?.dispatchEvent(new Event('webglcontextlost'));
  expect(renderer.dispose).toHaveBeenCalledOnce();
});

it('cleans up an addon that cannot activate', async () => {
  const { term, loadAddon, loseContext } = terminal(true);
  const stop = tryWebgl(term);
  await loaded();
  expect(loadAddon).toHaveBeenCalledOnce();
  expect(renderer.dispose).toHaveBeenCalledOnce();
  expect(loseContext).not.toHaveBeenCalled();
  stop();
});

it('skips activation if the pane goes away while importing the addon', async () => {
  const { term, loadAddon } = terminal();
  tryWebgl(term)();
  await loaded();
  expect(loadAddon).not.toHaveBeenCalled();
});
