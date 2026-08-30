import React from 'react';
import { Box, Text } from 'ink';
import { BLUE_HI, BLUE_DIM, MUTED, LOGO } from '../themes/blue.js';

const TAGLINE = 'Describe what you want done, or /help for commands.';

/** Border 1 each side plus the three rows of the mark. */
const CARD_ROWS = 5;

/**
 * The card, welded to the top of the window.
 *
 * Pinned rather than logged: as a transcript entry it scrolled away, taking the
 * only statement of what this tool is with it. It costs five rows, which is why
 * a window too small to spare them gets the wordmark on one line instead.
 *
 * Width and height are passed in rather than read from `stdout`: a resize is
 * only a re-render because the shell subscribed to it, and a header that read
 * the size for itself would draw at whatever the last render happened to see.
 */
export function Header({ shortCwd, version, cols, rows, title }: {
  shortCwd: string;
  version: string;
  cols: number;
  rows: number;
  /** What the run is working on, shown beside the wordmark on the compact line
   *  so a small window still says where it is. */
  title: string;
}) {
  if (cols < 70 || rows < CARD_ROWS + 12) {
    const right = title || shortCwd;
    const name = '◆ CodeMaster';
    const ver = ` v${version}`;
    const gap = Math.max(1, cols - 2 - name.length - ver.length - right.length);
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Box paddingX={1}>
          <Text bold color={BLUE_HI}>{name}</Text>
          <Text color={MUTED}>{ver}</Text>
          <Text>{' '.repeat(gap)}</Text>
          <Box width={Math.max(0, cols - 2 - name.length - ver.length - gap)}>
            <Text color={MUTED} wrap="truncate-middle">{right}</Text>
          </Box>
        </Box>
        <Text color={BLUE_DIM}>{'─'.repeat(cols)}</Text>
      </Box>
    );
  }

  return (
    <Box flexShrink={0}>
      <Box alignSelf="flex-start" borderStyle="round" borderColor={BLUE_DIM} paddingX={2} marginX={1}>
        <Box flexDirection="column" flexShrink={0} marginRight={2}>
          {LOGO.map((l, i) => <Text key={i} color={BLUE_HI} bold>{l}</Text>)}
        </Box>
        <Box flexDirection="column" width={Math.max(8, cols - 8 - LOGO[0]!.length - 2)}>
          <Box>
            <Text bold color={BLUE_HI}>CodeMaster</Text>
            <Text color={MUTED}>{`  v${version}`}</Text>
          </Box>
          <Text color={MUTED} wrap="truncate-middle">{title || shortCwd}</Text>
          <Text color={BLUE_DIM} wrap="truncate-end">{TAGLINE}</Text>
        </Box>
      </Box>
    </Box>
  );
}
