import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { BLUE_HI, BLUE_DIM, BLUE, MUTED } from '../themes/blue';

export interface Cmd { cmd: string; desc: string }

const MAX = 8;

/**
 * A plain list under the prompt, not a boxed panel.
 *
 * The box cost two rows of border and a rectangle of empty padding to the right
 * of the descriptions, and its column was `padEnd(12)` — one character wider
 * than the longest command shipped, so the next command added would have run
 * into its own description. The column is measured now.
 */
export function Autocomplete({ options, selectedIndex }: { options: Cmd[]; selectedIndex: number }) {
  if (!options.length) return null;
  // Keep the selection on screen when the list is longer than the window.
  const start = Math.min(Math.max(0, selectedIndex - MAX + 1), Math.max(0, options.length - MAX));
  const shown = options.slice(start, start + MAX);
  const col = Math.max(...options.map((o) => o.cmd.length)) + 2;
  const { stdout } = useStdout();
  // A description long enough to wrap turned one row into two and broke the
  // column everything else was aligned to.
  const desc = Math.max(6, Math.max(28, stdout?.columns ?? 80) - 2 - 2 - col);
  return (
    <Box flexDirection="column" paddingX={1}>
      {shown.map((opt, i) => {
        const on = start + i === selectedIndex;
        return (
          <Box key={opt.cmd}>
            <Text color={on ? BLUE_HI : BLUE_DIM} bold={on}>{on ? '❯ ' : '  '}</Text>
            <Text color={on ? BLUE_HI : BLUE} bold={on}>{opt.cmd.padEnd(col)}</Text>
            <Box width={desc}><Text color={MUTED} wrap="truncate-end">{opt.desc}</Text></Box>
          </Box>
        );
      })}
      {options.length > MAX && (
        <Text color={BLUE_DIM}>{`  +${options.length - MAX} more`}</Text>
      )}
    </Box>
  );
}
