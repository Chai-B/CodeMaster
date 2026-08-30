// Drag-to-select over the pinned frame.
//
// The frame lives on the alternate screen with the mouse claimed, which is the
// only way the wheel can reach us — and the price is that the terminal no
// longer gets click-drag, so its own selection and copy stop working. This puts
// them back by doing the job ourselves: track the drag, invert what it covers,
// and hand the text to the system clipboard when the button comes up.
//
// The text comes from the frame Ink already wrote rather than from React state.
// Reconstructing rows from the component tree would mean redoing the wrap and
// column arithmetic that `estimateRows` does, and getting a different answer
// whenever that estimate drifts. The frame is not an approximation of what is
// on screen; it is what is on screen.

import { spawnSync } from 'node:child_process';
import stripAnsi from 'strip-ansi';

/** A terminal cell, 1-based, the way mouse reports number them. */
export interface Pt {
  row: number;
  col: number;
}

/**
 * The text a drag from `a` to `b` covers, given the ANSI-free lines of the
 * frame with row 1 at index 0.
 *
 * Stream selection, the way a terminal behaves: the first row from the anchor
 * to its end, whole rows in between, and the last row up to the head. Pulled
 * out as a pure function because it is the part with all the off-by-ones and
 * the only part worth testing without a terminal attached.
 */
export function extract(lines: string[], a: Pt, b: Pt): string {
  if (!lines.length) return '';
  // A drag upward or to the left is the same selection as its mirror.
  const back = b.row < a.row || (b.row === a.row && b.col < a.col);
  const from = back ? b : a;
  const to = back ? a : b;

  const clamp = (r: number) => Math.max(1, Math.min(lines.length, r));
  const r1 = clamp(from.row);
  const r2 = clamp(to.row);
  const out: string[] = [];
  for (let r = r1; r <= r2; r++) {
    const line = lines[r - 1] ?? '';
    // The head column is included: the cell under the pointer is part of what
    // you dragged over, which is what every terminal does.
    const s = r === r1 ? Math.max(0, from.col - 1) : 0;
    const e = r === r2 ? Math.max(0, to.col) : line.length;
    out.push(line.slice(s, e).replace(/\s+$/, ''));
  }
  return out.join('\n');
}

/** Ink prefixes every frame with `eraseLines`, which is only these three. */
const ERASE = /^(?:\x1b\[2K|\x1b\[1A|\x1b\[G)+/;

/** Put text on the system clipboard. We are a local process, so the ordinary
 *  platform tool works and no terminal clipboard support is needed; OSC 52 is
 *  there for the case where none of them exist. */
function toClipboard(text: string, write: (s: string) => void): void {
  const tools: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
        ];
  for (const [cmd, args] of tools) {
    const r = spawnSync(cmd, args, { input: text });
    if (!r.error && r.status === 0) return;
  }
  write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
}

export class ScreenSelection {
  private raw: string[] = [];
  private plain: string[] = [];
  private anchor: Pt | null = null;
  private head: Pt | null = null;
  private readonly original: NodeJS.WriteStream['write'];

  constructor(private readonly stdout: NodeJS.WriteStream) {
    this.original = stdout.write.bind(stdout);
    // Every frame passes through here on its way out. Two things happen: the
    // rows are remembered so a drag has something to read, and the highlight is
    // re-drawn on top — Ink repaints continuously while a task runs, so a
    // one-shot overlay would blink out on the next spinner tick.
    (stdout as { write: unknown }).write = ((chunk: unknown, ...rest: unknown[]) => {
      const ok = (this.original as (...a: unknown[]) => boolean)(chunk, ...rest);
      if (typeof chunk === 'string') this.capture(chunk);
      if (this.active) this.paint(this.rows());
      return ok;
    }) as NodeJS.WriteStream['write'];
  }

  detach(): void {
    (this.stdout as { write: unknown }).write = this.original;
  }

  get active(): boolean {
    return this.anchor !== null && this.head !== null;
  }

  private capture(chunk: string): void {
    const body = chunk.replace(ERASE, '');
    if (!body.includes('\n')) return;
    const lines = body.split('\n');
    if (lines.at(-1) === '') lines.pop();
    // The root box is `height={rows}` on the alternate page, so a frame is the
    // window's rows in order and line `i` is row `i + 1`. Anything that is not
    // that shape is some other write and must not be mistaken for the screen.
    const h = this.stdout.rows ?? 0;
    if (!lines.length || lines.length < h - 2 || lines.length > h) return;
    this.raw = lines;
    this.plain = lines.map(stripAnsi);
  }

  begin(row: number, col: number): void {
    this.clear();
    this.anchor = { row, col };
    this.head = { row, col };
  }

  drag(row: number, col: number): void {
    if (!this.anchor) return;
    const before = this.rows();
    this.head = { row, col };
    this.paint([...new Set([...before, ...this.rows()])]);
  }

  /** Finish the drag and copy. Returns the number of lines put on the
   *  clipboard, or 0 when the "drag" never moved and was really a click. */
  end(): number {
    if (!this.anchor || !this.head) return 0;
    const moved = this.anchor.row !== this.head.row || this.anchor.col !== this.head.col;
    const text = moved ? extract(this.plain, this.anchor, this.head) : '';
    this.clear();
    if (!text.trim()) return 0;
    toClipboard(text, (s) => this.original(s));
    return text.split('\n').length;
  }

  clear(): void {
    const was = this.rows();
    this.anchor = null;
    this.head = null;
    this.paint(was);
  }

  /** Screen rows the current selection covers. */
  private rows(): number[] {
    if (!this.anchor || !this.head) return [];
    const lo = Math.max(1, Math.min(this.anchor.row, this.head.row));
    const hi = Math.min(this.plain.length, Math.max(this.anchor.row, this.head.row));
    const out: number[] = [];
    for (let r = lo; r <= hi; r++) out.push(r);
    return out;
  }

  /**
   * Redraw `rows`, inverted where selected and back to their own colours where
   * not. The cursor is saved and restored around the whole thing: Ink erases
   * its previous frame by counting lines up from wherever the cursor happens to
   * be, so moving it and leaving it moved would tear the next repaint.
   */
  private paint(rows: number[]): void {
    if (!rows.length) return;
    const on = new Set(this.rows());
    let out = '\x1b7';
    for (const r of rows) {
      const line = this.raw[r - 1];
      if (line === undefined) continue;
      out += `\x1b[${r};1H`;
      if (!on.has(r)) {
        // Not selected any more: the original line, colours and all.
        out += `\x1b[0m${line}\x1b[0m\x1b[K`;
        continue;
      }
      const [s, e] = this.span(r);
      const p = this.plain[r - 1] ?? '';
      // A selected row is drawn plain so the inverse is legible against it —
      // reverse video over the frame's own colours reads as noise.
      out += `\x1b[0m${p.slice(0, s)}\x1b[7m${(p.slice(s, e) || ' ').padEnd(e - s, ' ')}\x1b[27m${p.slice(e)}\x1b[K`;
    }
    out += '\x1b8';
    this.original(out);
  }

  /** Half-open column range of the selection on row `r`, 0-based. */
  private span(r: number): [number, number] {
    const a = this.anchor!;
    const b = this.head!;
    const back = b.row < a.row || (b.row === a.row && b.col < a.col);
    const from = back ? b : a;
    const to = back ? a : b;
    const len = (this.plain[r - 1] ?? '').length;
    const s = r === from.row ? Math.max(0, from.col - 1) : 0;
    const e = r === to.row ? Math.min(len, to.col) : len;
    return [Math.min(s, len), Math.max(Math.min(s, len), e)];
  }
}
