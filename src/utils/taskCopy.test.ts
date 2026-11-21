import { describe, expect, it } from 'vitest';
import { excerptFromSelection } from './taskCopy';

describe('excerptFromSelection', () => {
  it('drops the frame an agent draws around its text and keeps the text', () => {
    const screen = [
      '⏺ Gaps found:   ',
      '  ⎿  1. No drill-down',
      '     2. Stale marks stay',
      '',
      '',
      '╭──────────────╮',
      '│ hello world  │',
      '╰──────────────╯',
    ].join('\n');
    expect(excerptFromSelection(screen)).toBe('Gaps found:\n1. No drill-down\n2. Stale marks stay\n\nhello world');
  });

  it('keeps indentation that belongs to the text, and only one blank line in a row', () => {
    expect(excerptFromSelection('    fn main() {\n        run();\n    }\n')).toBe('fn main() {\n    run();\n}');
    expect(excerptFromSelection('\n\na\n\n\n\nb\n\n')).toBe('a\n\nb');
    expect(excerptFromSelection('line one\r\nline two')).toBe('line one\nline two');
  });

  it('leaves ordinary text and bullets alone', () => {
    expect(excerptFromSelection('• keep this bullet\n- and this one')).toBe('• keep this bullet\n- and this one');
    expect(excerptFromSelection('a │ b')).toBe('a │ b');
    expect(excerptFromSelection('   ')).toBe('');
  });
});
