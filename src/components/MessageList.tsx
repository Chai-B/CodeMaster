import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { LogEntry, LogType } from '../util/parser';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED, GREEN, RED, AMBER, VIOLET, GLYPH } from '../themes/blue';

/**
 * A fixed-height viewport onto the transcript, not a stream of it.
 *
 * Settled lines used to go through Ink's `<Static>`, which writes each one into
 * the terminal's own scrollback permanently. That is what made the composer
 * unpinnable: the transcript, the header and the prompt all belonged to the
 * same scroll region, so scrolling the window moved all three. The whole
 * interface is now a single frame exactly as tall as the window, and the
 * transcript is a window into the middle of it — the header and the composer
 * are simply other rows of that frame, and rows cannot scroll away from
 * themselves.
 *
 * The price is that the viewport must know how tall an entry is before it is
 * drawn, in order to choose how many of them fit. That is `estimateRows`.
 * Overflow is clipped at the top rather than the bottom (`justifyContent`
 * anchors the content to the last row), so when the estimate is a row short the
 * oldest line is cut, never the newest.
 */
export function MessageList({
  settled, live, expanded, height, scroll,
}: { settled: LogEntry[]; live: LogEntry[]; expanded: boolean; height: number; scroll: number }) {
  const cols = useCols();
  const all = [...settled, ...live];
  const h = Math.max(1, height);
  const rows = all.map((e) => estimateRows(e, cols, expanded));

  // Scrolling back drops whole entries off the bottom rather than splitting one
  // across the edge: half of a rendered box is worse to look at than a line of
  // slack, and an entry is never more than a few rows tall.
  let end = all.length;
  for (let dropped = 0; end > 1 && dropped < scroll; ) dropped += rows[--end]!;

  const fill = (budget: number) => {
    let i = end;
    for (let used = 0; i > 0 && used + rows[i - 1]! <= budget; ) used += rows[--i]!;
    return i === end && end > 0 ? end - 1 : i;
  };
  // When anything is hidden above, the row that says so has to come out of the
  // budget — added on top of a full window it would be the first thing clipped,
  // which is the one row that must not be.
  let start = fill(h);
  if (start > 0) start = fill(h - 1);

  return (
    <Box flexDirection="column" height={h} flexShrink={0} overflow="hidden" justifyContent="flex-end">
      {start > 0 && (
        <Text color={BLUE_DIM}>{`  ↑ ${start} earlier line${start === 1 ? '' : 's'}${scroll > 0 ? ' · shift+↓ or esc to return' : ''}`}</Text>
      )}
      <Transcript entries={all.slice(start, end)} expanded={expanded} />
    </Box>
  );
}

/** The lines themselves, at their natural height. Separate from the viewport so
 *  that what `estimateRows` claims can be measured against what Ink draws
 *  without the viewport's own padding standing in the way. */
export function Transcript({ entries, expanded }: { entries: LogEntry[]; expanded: boolean }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {entries.map((e) => <LogLine key={e.id} entry={e} expanded={expanded} />)}
    </Box>
  );
}

/** Total rendered height of the transcript, so the caller can clamp how far
 *  back it is allowed to scroll. */
export function totalRows(entries: LogEntry[], cols: number, expanded: boolean): number {
  let n = 0;
  for (const e of entries) n += estimateRows(e, cols, expanded);
  return n;
}

/** How many terminal rows a settled entry occupies once rendered. Kept beside
 *  the components it mirrors so the two stay in step. */
export function estimateRows(e: LogEntry, cols: number, expanded: boolean): number {
  const w = Math.max(28, cols);
  if (e.type === 'sep') return 2;
  if (e.type === 'md') {
    if (!e.text.trim()) return 1;
    if (/^#{1,6}\s/.test(e.text)) return 2;
    // The bold and code markers are consumed by Inline, so they take no columns.
    return wrapRows(e.text.replace(/\*\*|`/g, ''), w - 4);
  }
  let n = e.type === 'heading' || e.type === 'user' ? 2 : 1;
  if (e.detail && expanded) for (const d of e.detail.split('\n')) n += wrapRows(d, w - 7);
  return n;
}

/** Rows a string takes once word-wrapped to `avail` columns. Dividing the length
 *  by the width undercounts: a word that does not fit is moved down whole, so
 *  every line ends early by however much of the next word did not fit. */
function wrapRows(s: string, avail: number): number {
  const w = Math.max(8, avail);
  let rows = 1;
  let col = 0;
  for (const word of s.split(' ')) {
    const len = word.length;
    if (col > 0 && col + 1 + len <= w) { col += 1 + len; continue; }
    if (col > 0) rows += 1;
    if (len === 0) { col = 0; continue; }
    rows += Math.floor((len - 1) / w);
    col = ((len - 1) % w) + 1;
  }
  return rows;
}

/** The terminal width, floored so a very narrow window degrades instead of
 *  producing negative column budgets. */
function useCols(): number {
  const { stdout } = useStdout();
  return Math.max(28, stdout?.columns ?? 80);
}

/** A task boundary, captioned with the task it opens. The rule used to be blank,
 *  so the one thing worth knowing at that moment — which task just started —
 *  was thrown away with the event that carried it. */
function Rule({ title }: { title: string }) {
  const width = Math.min(useCols() - 2, 96);
  if (!title) return <Text color={BLUE_DIM}> {'─'.repeat(width)}</Text>;
  // The title is clipped before the rule is drawn, so a long one shortens the
  // trailing dashes instead of pushing the line off the edge of the screen.
  const room = Math.max(8, width - 8);
  const shown = title.length > room ? `${title.slice(0, room - 1)}…` : title;
  return (
    <Box marginTop={1}>
      <Text color={BLUE_DIM}>{' ── '}</Text>
      <Text color={BLUE_HI} bold>{shown}</Text>
      <Text color={BLUE_DIM}>{' ' + '─'.repeat(Math.max(1, width - shown.length - 5))}</Text>
    </Box>
  );
}

/** Model prose arrives as markdown and was being printed with its asterisks and
 *  backticks intact. Only the four constructs an answer actually uses are
 *  handled — bold, inline code, bullets, headings — because anything past that
 *  is a markdown parser, and this is a log line. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <Text>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) return <Text key={i} bold color={BLUE_HI}>{p.slice(2, -2)}</Text>;
        if (p.startsWith('`') && p.endsWith('`')) return <Text key={i} color={BLUE}>{p.slice(1, -1)}</Text>;
        return <Text key={i}>{p}</Text>;
      })}
    </Text>
  );
}

/** Prose wraps rather than truncates — an answer you can only read the first
 *  line of is not an answer. Everything is laid out against an explicit column
 *  budget: a flex row with no width measures at its natural size, so Ink never
 *  finds a column to break at and the text runs off the edge instead. */
function Markdown({ text }: { text: string }) {
  const cols = useCols();
  if (!text.trim()) return <Text> </Text>;
  const body = cols - 4;

  const heading = /^(#{1,6})\s+(.*)$/.exec(text);
  if (heading) {
    return (
      <Box marginTop={1} width={cols}>
        <Text>{'    '}</Text>
        <Box width={body}><Text bold color={BLUE_HI} wrap="truncate-end">{heading[2]}</Text></Box>
      </Box>
    );
  }

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(text);
  if (bullet) {
    const pad = bullet[1]!.length;
    return (
      <Box width={cols}>
        <Text>{'    '}{' '.repeat(pad)}</Text>
        <Text color={BLUE_DIM}>{'• '}</Text>
        <Box width={Math.max(8, body - pad - 2)}><Inline text={bullet[2]!} /></Box>
      </Box>
    );
  }

  const numbered = /^(\s*)(\d+\.)\s+(.*)$/.exec(text);
  if (numbered) {
    const pad = numbered[1]!.length;
    const mark = numbered[2]!;
    return (
      <Box width={cols}>
        <Text>{'    '}{' '.repeat(pad)}</Text>
        <Text color={BLUE_DIM}>{mark} </Text>
        <Box width={Math.max(8, body - pad - mark.length - 1)}><Inline text={numbered[3]!} /></Box>
      </Box>
    );
  }

  return (
    <Box width={cols}>
      <Text>{'    '}</Text>
      <Box width={body}><Inline text={text} /></Box>
    </Box>
  );
}

/** Glyph, its colour, the text colour, and whether the text is bold.
 *  Every type occupies the same gutter, so body text lands in one column
 *  whatever the type — it used to land in three different ones. A `result` is
 *  the outcome of the `tool` line above it and hangs off it on an elbow. */
const STYLE: Record<LogType, { glyph: string; mark: string; color?: string; bold?: boolean; indent?: boolean }> = {
  tool: { glyph: GLYPH.tool, mark: BLUE_HI, color: undefined },
  result: { glyph: GLYPH.result, mark: BLUE_DIM, color: MUTED, indent: true },
  success: { glyph: GLYPH.success, mark: GREEN, color: GREEN },
  error: { glyph: GLYPH.error, mark: RED, color: RED },
  warn: { glyph: GLYPH.warn, mark: AMBER, color: AMBER },
  reasoning: { glyph: GLYPH.reasoning, mark: VIOLET, color: MUTED },
  user: { glyph: GLYPH.user, mark: BLUE_HI, color: undefined, bold: true },
  dim: { glyph: ' ', mark: MUTED, color: MUTED },
  heading: { glyph: ' ', mark: BLUE_HI, color: BLUE_HI, bold: true },
  plain: { glyph: ' ', mark: MUTED, color: undefined },
  sep: { glyph: ' ', mark: MUTED, color: undefined },
  md: { glyph: ' ', mark: MUTED, color: undefined },
};

function LogLine({ entry, expanded }: { entry: LogEntry; expanded: boolean }) {
  const { type, text, detail } = entry;
  const cols = useCols();
  if (type === 'sep') return <Rule title={text} />;
  if (type === 'md') return <Markdown text={text} />;
  if (type === 'plain' && !text.trim()) return <Text> </Text>;

  const s = STYLE[type] ?? STYLE.plain;
  const gutter = s.indent ? 6 : 4;
  const fold = detail && !expanded ? 3 : 0;
  const line = (
    <Box width={cols}>
      <Text color={s.mark} bold={!s.indent}>{s.indent ? '   ' : ' '}{s.glyph}{'  '}</Text>
      <Box width={Math.max(8, cols - gutter - fold)}>
        <Text color={s.color} bold={s.bold} wrap="truncate-end">{text}</Text>
      </Box>
      {/* The fold affordance keeps its own space rather than being the thing
          truncation eats — a hidden "there is more here" marker is useless. */}
      {fold > 0 && <Text color={BLUE_DIM}>{'  ⌄'}</Text>}
    </Box>
  );
  // A heading opens a block and a prompt echo closes one; both need the air.
  const spaced = type === 'heading' || type === 'user' ? <Box marginTop={1}>{line}</Box> : line;
  if (!detail || !expanded) return spaced;
  return (
    <Box flexDirection="column">
      {spaced}
      {detail.split('\n').map((d, i) => (
        <Box key={i} width={cols}>
          <Text color={BLUE_DIM}>{'     │ '}</Text>
          <Box width={Math.max(8, cols - 7)}><Text color={MUTED}>{d}</Text></Box>
        </Box>
      ))}
    </Box>
  );
}
