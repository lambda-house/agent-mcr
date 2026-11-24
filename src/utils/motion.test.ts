// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INACTIVE_CLASS, watchWindowActivity } from './motion';

// Vitest hands CSS imports over empty: the stylesheets are read from disk
const styles = ['harness.css', 'index.css', 'ui.css', 'sessions.css'].map(name => {
  try { return readFileSync(`${process.cwd()}/src/styles/${name}`, 'utf8'); } catch { return ''; }
}).join('\n');
const harness = readFileSync(`${process.cwd()}/src/styles/harness.css`, 'utf8');
/** Every declaration block whose selector names `part` */
const rules = (css: string, part: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].includes(part)).map(m => m[2]);
const keyframes = (css: string, name: string) => { const at = css.indexOf(`@keyframes ${name}`); return at < 0 ? '' : css.slice(at, css.indexOf('} }', at) + 3); };

const root = () => document.documentElement.classList;
let undo = () => {};
afterEach(() => { undo(); vi.restoreAllMocks(); });

describe('animations stop (MCR-139)', () => {
  it('runs the working ripple and the warm cache glow a few times, never for good', () => {
    for (const part of ['.hs-dot.working::after', '.hs-list li.cache-warm::after']) {
      const animated = rules(harness, part).filter(body => /animation:\s*hs-/.test(body));
      expect(animated.length, part).toBeGreaterThan(0);
      for (const body of animated) expect(body, part).toMatch(/animation:\s*hs-[a-z]+ [^;]* 3;/);
    }
    expect(rules(harness, '.hs-dot.working').join('\n')).not.toContain('infinite');
    expect(rules(harness, 'cache-warm').join('\n')).not.toContain('infinite');
  });

  it('lets the glow change only the opacity of its own layer, never the row\'s box-shadow', () => {
    expect(keyframes(harness, 'hs-ember')).toMatch(/@keyframes hs-ember \{ 50% \{ opacity: 1; \} \}/);
    const row = [...harness.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].includes('li.cache-warm') && !m[1].includes('::after'));
    expect(row.length).toBeGreaterThan(0);
    for (const [, selector, body] of row) expect(body.replace(/animation:\s*none/g, ''), selector).not.toContain('animation');
  });

  it('has no animation that runs for good anywhere, but a spinner shown while work is under way', () => {
    const forever = [...styles.matchAll(/([^{}]+)\{([^{}]*infinite[^{}]*)\}/g)].map(m => m[1].trim());
    expect(forever.every(selector => /\.spinning\b/.test(selector)), forever.join(' | ')).toBe(true);
  });

  it('pauses every animation while the window is in the background', () => {
    expect(harness).toContain(`:root.${INACTIVE_CLASS} *, :root.${INACTIVE_CLASS} *::before, :root.${INACTIVE_CLASS} *::after { animation-play-state: paused !important; }`);
  });
});

describe('watchWindowActivity', () => {
  it('marks the root while the window has no focus or is hidden, and takes the mark away with focus', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    undo = watchWindowActivity(window);
    expect(root().contains(INACTIVE_CLASS)).toBe(false);
    window.dispatchEvent(new Event('blur'));
    expect(root().contains(INACTIVE_CLASS)).toBe(true);
    window.dispatchEvent(new Event('focus'));
    expect(root().contains(INACTIVE_CLASS)).toBe(false);
    // Hidden counts whatever the focus says
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root().contains(INACTIVE_CLASS)).toBe(true);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root().contains(INACTIVE_CLASS)).toBe(false);
    focus.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root().contains(INACTIVE_CLASS)).toBe(true);
  });

  it('starts marked when the window opens in the background, and the undo leaves the root unmarked and deaf', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    undo = watchWindowActivity(window);
    expect(root().contains(INACTIVE_CLASS)).toBe(true);
    undo(); undo = () => {};
    expect(root().contains(INACTIVE_CLASS)).toBe(false);
    window.dispatchEvent(new Event('blur'));
    expect(root().contains(INACTIVE_CLASS)).toBe(false);
  });
});
