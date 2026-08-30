import React from 'react';
import { Box, Text } from 'ink';
import { BLUE_HI, BLUE_DIM, MUTED } from '../themes/blue.js';

/**
 * Two rows welded to the top of the window.
 *
 * The three-row mark this replaced was printed once and read once, which is
 * fine for something that scrolls away — but the header is now pinned, so every
 * row it takes is a row the transcript never gets back. What stays is the one
 * thing worth having permanently on screen beside the wordmark: what the run is
 * currently working on, or where you are when nothing is running.
 */
export function HeaderBar({ version, shortCwd, title, cols }: {
  version: string;
  shortCwd: string;
  title: string;
  /** Passed in rather than read from `stdout`: a resize is only a re-render
   *  because the shell subscribed to it, and a header that read the width for
   *  itself would draw its rule at whatever width the last render happened to
   *  see. */
  cols: number;
}) {
  const name = `◆ CodeMaster`;
  const ver = ` v${version}`;
  const right = title || shortCwd;
  // The right-hand half is whatever is left after the wordmark, and never less
  // than nothing — a 28-column window shows the name alone.
  const gap = Math.max(1, cols - 2 - name.length - ver.length - right.length);
  const room = Math.max(0, cols - 2 - name.length - ver.length - gap);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box paddingX={1}>
        <Text bold color={BLUE_HI}>{name}</Text>
        <Text color={MUTED}>{ver}</Text>
        <Text>{' '.repeat(gap)}</Text>
        <Box width={room}>
          <Text color={MUTED} wrap="truncate-middle">{right}</Text>
        </Box>
      </Box>
      <Text color={BLUE_DIM}>{'─'.repeat(cols)}</Text>
    </Box>
  );
}
