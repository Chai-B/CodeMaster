import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED } from '../themes/blue';
import type { SessionStatusView } from '../util/parser';

interface HeaderProps {
  shortCwd: string;
  version: string;
  session: SessionStatusView | null;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * One line during a session, a short orientation block when idle.
 *
 * The old header was a seven-row bordered box holding an ASCII logo, a divider
 * column and three label rows that repeated what the status bar already said —
 * six permanently occupied rows on every terminal, however small.
 */
export function Header({ shortCwd, version, session }: HeaderProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  if (session) {
    // A flex row of separate <Text> nodes wraps each field independently, which
    // shattered this line into two on a narrow terminal. Fields are dropped
    // least-useful-first instead: the budget is what you watch during a run,
    // the path is what you already know.
    const fields: Array<[string, string]> = [
      ['CodeMaster', BLUE_HI],
      [shortCwd, MUTED],
      [session.provider, BLUE],
      [`task ${session.taskN}/${session.taskTotal}`, MUTED],
      [`${fmt(session.tokens)}/${fmt(session.tokenBudget)}`, MUTED],
    ];
    const drop = [1, 0, 2, 3]; // cwd, name, provider, tasks
    const width = (f: typeof fields) => f.reduce((n, [t]) => n + t.length, 0) + (f.length - 1) * 3;
    const gone = new Set<number>();
    for (const i of drop) {
      if (width(fields.filter((_, j) => !gone.has(j))) <= cols - 2) break;
      gone.add(i);
    }
    const shown = fields.filter((_, j) => !gone.has(j));
    return (
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          {shown.map(([text, color], i) => (
            <Text key={text} color={color} bold={text === 'CodeMaster'}>
              {i > 0 ? ' · ' : ''}{text}
            </Text>
          ))}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box gap={1}>
        <Text bold color={BLUE_HI}>CodeMaster</Text>
        <Text color={MUTED}>{version}</Text>
        <Text color={BLUE_DIM}>·</Text>
        <Text color={MUTED}>{shortCwd}</Text>
      </Box>
      <Text color={MUTED}>Type what you want done. /help for commands.</Text>
    </Box>
  );
}
