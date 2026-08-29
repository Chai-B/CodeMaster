import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED, GREEN, AMBER, RED, LOGO } from '../themes/blue';
import type { SessionStatusView, UsageView } from '../util/parser';

interface HeaderProps {
  shortCwd: string;
  version: string;
  session: SessionStatusView | null;
  usage: UsageView;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Eight cells of budget, filled proportionally, coloured by how much is left.
 *  A bare `152.0k/500.0k` makes you do the division yourself; the bar is the
 *  one thing in the header you can read without reading it. */
function Budget({ used, total }: { used: number; total: number }) {
  const cells = 8;
  const frac = total > 0 ? Math.min(1, used / total) : 0;
  const on = Math.round(frac * cells);
  const color = frac > 0.9 ? RED : frac > 0.7 ? AMBER : GREEN;
  return (
    <Text>
      <Text color={color}>{'━'.repeat(on)}</Text>
      <Text color={BLUE_DIM}>{'━'.repeat(cells - on)}</Text>
      <Text color={MUTED}> {fmt(used)}</Text>
    </Text>
  );
}

/**
 * One line during a session, the wordmark and the C at rest.
 *
 * The banner this replaced was a seven-row bordered box whose right half
 * repeated what the status bar already said. The logo stays — it is the only
 * part anyone was attached to — and everything beside it is now information
 * that changes.
 */
export function Header({ shortCwd, version, session, usage }: HeaderProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  // The card is part of the header, not the first thing in the transcript: it
  // used to be logged as an entry and so scrolled away, taking the only
  // statement of what this tool is with it. Pinned instead — but only while
  // nothing is running and only when the window can spare the rows.
  if (!session && headerRows(cols, stdout?.rows ?? 24, false) > 1) {
    return (
      <Box flexDirection="column">
        <Banner shortCwd={shortCwd} version={version} />
        <StatusLine shortCwd={shortCwd} usage={usage} cols={cols} />
      </Box>
    );
  }

  if (session) {
    // A flex row of separate <Text> nodes wraps each field independently, which
    // shattered this line into two on a narrow terminal. Fields are dropped
    // least-useful-first instead: the budget is what you watch during a run,
    // the path is what you already know.
    const cost = session.cost > 0 ? `$${session.cost.toFixed(2)}` : '';
    const fields: Array<[string, string, React.ReactNode?]> = [
      [shortCwd, MUTED],
      [session.provider, BLUE],
      [`${session.taskN}/${session.taskTotal}`, MUTED],
      ['', MUTED, <Budget key="b" used={session.tokens} total={session.tokenBudget} />],
      [cost, MUTED],
      [usage.blockedMs > 0 ? `limited ${mins(usage.blockedMs)}` : '', RED],
    ];
    const live = fields.filter(([t, , node]) => t || node);
    const drop = [0, 4, 1, 2]; // cwd, cost, provider, task count — the limit warning never drops
    const len = (f: typeof live) => f.reduce((n, [t, , node]) => n + (node ? 9 + fmt(session.tokens).length : t.length), 0) + (f.length - 1) * 3;
    const gone = new Set<number>();
    for (const i of drop) {
      if (len(live.filter((_, j) => !gone.has(j))) <= cols - 4) break;
      gone.add(i);
    }
    const shown = live.filter((_, j) => !gone.has(j));
    return (
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          {shown.map(([text, color, node], i) => (
            <Text key={text || 'budget'}>
              {i > 0 ? <Text color={BLUE_DIM}> · </Text> : ''}
              {node ?? <Text color={color}>{text}</Text>}
            </Text>
          ))}
        </Text>
      </Box>
    );
  }

  return <StatusLine shortCwd={shortCwd} usage={usage} cols={cols} />;
}

/** The card costs five rows and the C needs the width; a small window needs
 *  both for output more than it needs the wordmark. Kept beside the component
 *  it measures so the two cannot drift. */
export function headerRows(cols: number, rows: number, session: boolean): number {
  return !session && cols >= 70 && rows >= 22 ? BANNER_ROWS + 1 : 1;
}

/** Border 1 each side plus the three rows of the C. */
const BANNER_ROWS = 5;

/** At rest the one line still has to answer "what will this cost me and can I
 *  even run it right now" — which used to require two slash commands. */
function StatusLine({ shortCwd, usage, cols }: { shortCwd: string; usage: UsageView; cols: number }) {
  const parts: Array<[string, string]> = [[shortCwd, MUTED], [usage.model, BLUE]];
  if (usage.blockedMs > 0) parts.push([`rate limited ${mins(usage.blockedMs)}`, RED]);
  else if (usage.windowTokens > 0) parts.push([`${fmt(usage.windowTokens)} this window`, MUTED]);
  if (usage.spend > 0) parts.push([`$${usage.spend.toFixed(2)} total`, MUTED]);
  void cols;
  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        {parts.map(([t, c], i) => (
          <Text key={t}>
            {i > 0 ? <Text color={BLUE_DIM}> · </Text> : ''}
            <Text color={c}>{t}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function mins(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  return m >= 60 ? `${Math.ceil(m / 60)}h` : `${m}m`;
}

const TAGLINE = 'Describe what you want done, or /help for commands.';

/** The startup card: the C, the wordmark, where you are. Part of the pinned
 *  header rather than the first line of the transcript — logged as an entry it
 *  scrolled away, taking the only statement of what the tool is with it.
 *  Drawn only above 70 columns, which is what makes it exactly BANNER_ROWS. */
export function Banner({ shortCwd, version }: { shortCwd: string; version: string }) {
  return (
    <Box alignSelf="flex-start" borderStyle="round" borderColor={BLUE_DIM} paddingX={2} marginX={1}>
      <Box flexDirection="column" flexShrink={0} marginRight={2}>
        {LOGO.map((l, i) => <Text key={i} color={BLUE_HI} bold>{l}</Text>)}
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text bold color={BLUE_HI}>CodeMaster</Text>
          <Text color={MUTED}>  v{version}</Text>
        </Box>
        <Text color={MUTED}>{shortCwd}</Text>
        <Text color={BLUE_DIM}>{TAGLINE}</Text>
      </Box>
    </Box>
  );
}
