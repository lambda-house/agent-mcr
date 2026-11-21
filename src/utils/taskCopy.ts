/**
 * "Copy as task" (MCR-125 v0): the passage selected in a terminal, as the
 * dialog shows it and the task quotes it. Only what is drawn around the
 * text goes: the frame characters agents draw (box rules and corners,
 * Claude Code's ⏺ and ⎿, a ● at the start of a line), trailing spaces, and
 * blank lines at the ends or more than one in a row. xterm has already
 * joined the lines it wrapped. Safety (escape sequences, invisible
 * characters, bounds, credentials) is checked again by the app's Rust side,
 * which builds the text that is copied.
 */

/** The most of a terminal that goes into one task, in characters (`task_copy::MAX_EXCERPT`). */
export const MAX_EXCERPT = 4000;
/** The most the instruction may hold (`task_copy::MAX_INSTRUCTION`). */
export const MAX_INSTRUCTION = 1000;

/** Box drawing (U+2500–U+257F), ⎿ (U+23BF), ⏺ (U+23FA), ● (U+25CF), ✻ (U+273B). */
const FRAME = '\u2500-\u257f\u23bf\u23fa\u25cf\u273b';
const LEADING = new RegExp(`^[ \\t]*(?:[${FRAME}][ \\t]*)+`);
const TRAILING = new RegExp(`(?:[ \\t]*[\u2500-\u257f])+[ \\t]*$`);
const RULE = new RegExp(`^[ \\t${FRAME}]*$`);

export function excerptFromSelection(selection: string): string {
  const out: string[] = [];
  // Where the text began after the frame on the last framed line: the lines
  // that continue it are indented to there, and lose that indentation too
  let content = 0;
  for (const raw of selection.replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw.replace(/[ \t]+$/, '').replace(TRAILING, '');
    if (RULE.test(line)) { out.push(''); continue; }
    const lead = LEADING.exec(line);
    if (lead) {
      content = lead[0].length;
      line = line.slice(content);
    } else {
      const spaces = /^ */.exec(line)![0].length;
      if (content > 0 && spaces >= content) line = line.slice(content);
      else content = 0;
    }
    out.push(line);
  }
  // The indentation every line shares goes too
  const indents = out.filter(l => l.trim()).map(l => /^ */.exec(l)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  const lines: string[] = [];
  for (const l of out.map(l => l.slice(common))) {
    if (!l.trim() && (lines.length === 0 || !lines[lines.length - 1].trim())) continue;
    lines.push(l.trim() ? l : '');
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}
