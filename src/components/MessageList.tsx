import React from 'react';
import { Box, Static, Text, useStdout } from 'ink';
import { LogEntry, LogType } from '../util/parser';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED, GREEN, RED, AMBER, VIOLET, GLYPH } from '../themes/blue';

/**
 * Settled lines are written once and scroll natively; only the live region
 * repaints.
 *
 * Every log line used to re-render on every bus event, and once output passed
 * the terminal height Ink's frame diffing tore visibly — the flicker. `<Static>`
 * hands a settled line to the terminal exactly once, so a long run costs one
 * write per line instead of one per line per event.
 */
export function MessageList({
  settled, live, clearGen, expanded,
}: { settled: LogEntry[]; live: LogEntry[]; clearGen: number; expanded: boolean }) {
  return (
    <>
      {/* Expanding is a repaint: <Static> writes an item once and never revisits
          it, so the whole settled region has to remount to show detail that was
          folded away when it first scrolled past. */}
      <Static key={`${clearGen}:${expanded}`} items={settled}>
        {(e) => <LogLine key={e.id} entry={e} expanded={expanded} />}
      </Static>
      {live.length > 0 && (
        <Box flexDirection="column">
          {live.map((e) => <LogLine key={e.id} entry={e} expanded={expanded} />)}
        </Box>
      )}
    </>
  );
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
